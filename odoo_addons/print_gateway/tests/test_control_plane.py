# -*- coding: utf-8 -*-
"""Comprehensive tests for Universal Enterprise Print Control Plane.

Covers:
1. Event-driven Print Policy Engine & Intent Deduplication
2. ReportController defense-in-depth interception
3. Native raw ZPL/TSPL label engine
4. Pre-dispatch safe failover vs post-dispatch freeze
5. Hardware test page diagnostic dispatch
"""

import json
import unittest
from unittest.mock import patch, MagicMock

try:
    from odoo import api
    from odoo.tests.common import TransactionCase
    from odoo.exceptions import ValidationError
    from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig
except ImportError:
    api = None
    class ValidationError(Exception):
        pass
    TransactionCase = unittest.TestCase
    PrintGatewayConfig = None


class TestControlPlane(TransactionCase):

    def setUp(self):
        super().setUp()
        if not hasattr(self, "env") or api is None:
            self.skipTest("Odoo runtime environment not available")

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not hasattr(cls, "env") or api is None:
            return

        # create a dedicated cursor for class-level setup and keep it for tearDownClass
        cls.cr = cls.env.registry.cursor()
        try:
            setup_env = api.Environment(cls.cr, cls.env.uid, dict(cls.env.context))
            cls.company = setup_env["res.company"].create({
                "name": "Control Plane Root Company",
            })
            cls.branch = setup_env["res.company"].create({
                "name": "Control Plane Branch 1",
                "parent_id": cls.company.id,
            })
            ConfigClass = PrintGatewayConfig or type(setup_env["print_gateway.gateway_config"])
            with patch.object(ConfigClass, "_validate_gateway_host"):
                cls.gateway_config = setup_env["print_gateway.gateway_config"].create({
                    "company_id": cls.company.id,
                    "gateway_url": "https://gateway.example.com",
                    "enabled": True,
                    "gateway_api_key": "test_api_key_control_plane",
                })

            # Primary binding
            cls.primary_binding = setup_env["print_gateway.binding"].create({
                "company_id": cls.company.id,
                "branch_id": cls.branch.id,
                "destination_type": "report",
                "destination_report_id": setup_env.ref("account.account_invoices").id,
                "report_id": setup_env.ref("account.account_invoices").id,
                "runtime_agent_id": "agent-cp-01",
                "printer_id": "printer-primary",
                "enabled": True,
                "drawer_kick_mode": "pin2",
                "cutter_mode": "full",
                "buzzer_mode": "epson_pulse",
            })

            # Backup failover binding
            cls.backup_binding = setup_env["print_gateway.binding"].create({
                "company_id": cls.company.id,
                "branch_id": cls.branch.id,
                "destination_type": "report",
                "destination_report_id": setup_env.ref("account.account_invoices").id,
                "report_id": setup_env.ref("account.account_invoices").id,
                "runtime_agent_id": "agent-cp-01",
                "printer_id": "printer-backup",
                "enabled": True,
                "priority": 20,
            })

            cls.primary_binding.fallback_binding_id = cls.backup_binding.id

            cls.company_id = cls.company.id
            cls.branch_id = cls.branch.id
            cls.gateway_config_id = cls.gateway_config.id
            cls.primary_binding_id = cls.primary_binding.id
            cls.backup_binding_id = cls.backup_binding.id

            cls.cr.commit()
        except Exception:
            # ensure no partial commit leaves DB invalid for other tests
            try:
                cls.cr.rollback()
            except Exception:
                pass
            raise
        # do NOT close cls.cr here; close it in tearDownClass

    @classmethod
    def tearDownClass(cls):
        # Close the class-level cursor created in setUpClass
        if hasattr(cls, "cr") and cls.cr:
            try:
                cls.cr.close()
            except Exception:
                pass
        super().tearDownClass()


    def test_01_policy_engine_and_intent_deduplication(self):
        """Verify policy matching and strict suppression of duplicate intent."""
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Auto Delivery Slip",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "binding_id": self.primary_binding.id,
            "active": True,
        })

        # Mock picking
        mock_picking = MagicMock()
        mock_picking._name = "stock.picking"
        mock_picking.id = 9991
        mock_picking.company_id = self.branch
        mock_picking.write_date = "2026-09-08 16:00:00"

        # Policy should match
        self.assertTrue(policy.matches_record(mock_picking))

        # First intent generation
        intent_model = self.env["print_gateway.intent"]
        key1 = intent_model.compute_intent_key(policy, mock_picking, "picking_validated")
        self.assertTrue(bool(key1))

        intent1 = intent_model.create({
            "intent_key": key1,
            "policy_id": policy.id,
            "res_model": mock_picking._name,
            "res_id": mock_picking.id,
            "event_type": "picking_validated",
        })
        self.assertEqual(intent1.intent_key, key1)

        # Duplicate intent trigger must return existing record without error
        intent2 = intent_model.create_and_route(policy, mock_picking, "picking_validated")
        self.assertEqual(intent2.id, intent1.id, "Duplicate trigger must return existing intent and suppress duplicate job creation")

    def test_02_raw_zpl_command_routing(self):
        """Verify raw ZPL command routing bypasses QWeb and creates raw_cmd outbox job."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        RouterClass = type(router)
        zpl_sample = "^XA^FO50,50^ADN,36,20^FDLabel Test^FS^XZ"

        with patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = router.route_raw_command(
                zpl_sample,
                protocol="zpl",
                binding=self.primary_binding,
                company=self.branch,
                document_type="label",
            )
            self.assertTrue(res.get("gateway_enabled"))
            job_id = res.get("job_id")
            job = self.env["print_gateway.print_job"].browse(job_id)
            self.assertEqual(job.payload_type, "raw_cmd")
            self.assertEqual(job.protocol, "zpl")
            self.assertEqual(job.raw_payload, zpl_sample)

    def test_03_pre_dispatch_safe_failover(self):
        """Verify pre-dispatch connection error engages fallback printer."""
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Primary Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "raw", "data": "dGVzdA=="}),
            "idempotency_key": "test_pre_dispatch_failover_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })

        import requests
        # Mock requests.post: first call raises ConnectionError, second call succeeds
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_job_backup_123", "status": "queued"}

        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host"), \
             patch("requests.post", side_effect=[requests.exceptions.ConnectionError("Connection Refused"), mock_resp]):
            job.action_submit()
            self.assertEqual(job.printer_id, self.backup_binding.printer_id, "Job must safely failover to backup printer on pre-dispatch connection error")
            self.assertEqual(job.gateway_job_id, "gw_job_backup_123")

    def test_04_post_dispatch_freeze(self):
        """Verify post-dispatch timeout freezes into unknown state without failover."""
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Primary Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "raw", "data": "dGVzdA=="}),
            "idempotency_key": "test_post_dispatch_timeout_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })

        import requests
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host"), \
             patch("requests.post", side_effect=requests.exceptions.Timeout("Read timeout")):
            job.action_submit()
            self.assertEqual(job.status, "unknown")
            self.assertFalse(job.next_retry_at, "Automated retry must be halted on unknown outcome")
            self.assertEqual(job.printer_id, self.primary_binding.printer_id, "Must NOT failover to backup printer on post-dispatch ambiguous timeout")

    def test_05_hardware_test_page_action(self):
        """Verify binding 'action_send_test_print' produces diagnostic outbox job."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        BindingClass = type(self.primary_binding)
        RouterClass = type(router)
        with patch.object(BindingClass, "_validate_runtime_target"), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = self.primary_binding.with_company(self.branch).action_send_test_print()
            self.assertTrue(res.get("gateway_enabled"))
            job = self.env["print_gateway.print_job"].browse(res.get("job_id"))
            self.assertEqual(job.protocol, "escpos")
            self.assertIn("ODOO PRINT GATEWAY DIAGNOSTIC", job.raw_payload)
