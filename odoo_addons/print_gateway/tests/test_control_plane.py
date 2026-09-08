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

        self.company = self.env.company
        self.branch = self.env["res.company"].create({
            "name": "Control Plane Branch 1",
            "parent_id": self.company.id,
        })
        self.env = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id, self.branch.id]))

        ConfigClass = PrintGatewayConfig or type(self.env["print_gateway.gateway_config"])
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None):
            config_model = self.env["print_gateway.gateway_config"]
            self.gateway_config = config_model.search([("company_id", "=", self.company.id)], limit=1)
            vals = {
                "gateway_url": "https://gateway.example.com",
                "enabled": True,
                "gateway_api_key": "test_api_key_control_plane",
            }
            if self.gateway_config:
                self.gateway_config.write(vals)
            else:
                self.gateway_config = config_model.create({
                    "company_id": self.company.id,
                    **vals,
                })

        report = (
            self.env.ref("account.account_invoices", raise_if_not_found=False)
            or self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
            or self.env["ir.actions.report"].search([], limit=1)
        )

        # Primary binding
        self.primary_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": report.id if report else False,
            "report_id": report.id if report else False,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-primary",
            "printer_protocol": "escpos",
            "enabled": True,
            "drawer_kick_mode": "pin2",
            "cutter_mode": "full",
            "buzzer_mode": "epson_pulse",
        })

        # ZPL binding
        self.zpl_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": report.id if report else False,
            "report_id": report.id if report else False,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-zpl",
            "printer_protocol": "zpl",
            "enabled": True,
        })

        # Backup failover binding
        self.backup_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": report.id if report else False,
            "report_id": report.id if report else False,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-backup",
            "printer_protocol": "escpos",
            "enabled": True,
            "priority": 20,
        })

        self.primary_binding.fallback_binding_id = self.backup_binding.id

    def _fake_persist_job(self, values):
        durable_values = dict(values)
        for key, model_name in (
            ("company", "res.company"),
            ("gateway_config", "print_gateway.gateway_config"),
            ("report", "ir.actions.report"),
            ("fallback_binding", "print_gateway.binding"),
        ):
            record = durable_values.get(key)
            if record and hasattr(record, "id"):
                durable_values[key] = record
            elif record:
                durable_values[key] = self.env[model_name].browse(record)
            else:
                durable_values[key] = False
        target_company = durable_values.get("company")
        model = self.env["print_gateway.print_job"]
        if target_company:
            model = model.with_company(target_company)
        job = model.create_operation(**durable_values)
        return job.id

    def test_01_policy_engine_and_intent_deduplication(self):
        """Verify policy matching and strict suppression of duplicate intent."""
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        if not model:
            model = self.env["ir.model"].search([], limit=1)
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
        mock_picking._name = model.model
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

        with patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = router.route_raw_command(
                zpl_sample,
                protocol="zpl",
                binding=self.zpl_binding,
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
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
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
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
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
             patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = self.primary_binding.with_company(self.branch).action_send_test_print()
            self.assertTrue(res.get("gateway_enabled"))
            job = self.env["print_gateway.print_job"].browse(res.get("job_id"))
            self.assertEqual(job.protocol, "escpos")
            self.assertIn("ODOO PRINT GATEWAY DIAGNOSTIC", job.raw_payload)

    def test_06_intent_crash_recovery_cron(self):
        """Verify cron_recover_pending_intents recovers stale claimed or pending intents."""
        intent_model = self.env["print_gateway.intent"]
        model = self.env["ir.model"].search([], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Cron Recovery Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "test_event",
            "binding_id": self.primary_binding.id,
            "active": True,
        })
        intent = intent_model.create({
            "intent_key": "stale_intent_test_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "test_event",
            "status": "pending",
        })
        with patch.object(intent_model, "_dispatch_intent_postcommit") as mock_dispatch:
            recovered = intent_model.cron_recover_pending_intents()
            self.assertGreaterEqual(recovered, 1)
            mock_dispatch.assert_called()

    def test_07_failover_cycle_safety(self):
        """Verify cycle in fallback bindings terminates without infinite recursion."""
        # Create circular fallback: primary -> backup -> primary
        self.backup_binding.fallback_binding_id = self.primary_binding.id
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Cycle Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "raw", "data": "dGVzdA=="}),
            "idempotency_key": "test_cycle_safety_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })
        import requests
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=requests.exceptions.ConnectionError("Connection Failed")):
            # Must terminate gracefully, not hang in recursion
            job.action_submit()
            self.assertIn(job.status, ("failed", "queued"))

    def test_08_raw_command_idempotency_and_authorization(self):
        """Verify route_raw_command accepts explicit idempotency key and enforces binding validation."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        RouterClass = type(router)
        disabled_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-disabled",
            "enabled": False,
            "priority": 99,
        })
        with self.assertRaises(ValidationError):
            router.route_raw_command(
                "^XA^XZ",
                binding=disabled_binding,
                company=self.branch,
            )

        with patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = router.route_raw_command(
                "\x1b@Hello",
                protocol="escpos",
                binding=self.primary_binding,
                company=self.branch,
                idempotency_key="custom_explicit_key_123",
            )
            job = self.env["print_gateway.print_job"].browse(res["job_id"])
            self.assertEqual(job.idempotency_key, "custom_explicit_key_123")

    def test_09_policy_template_format_error_raises(self):
        """Verify render_raw_template raises ValidationError on missing format keys."""
        model = self.env["ir.model"].search([("model", "=", "res.company")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Template Error Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "test_event",
            "raw_template": "Hello {non_existent_field_xyz}!",
            "active": True,
        })
        with self.assertRaises(ValidationError):
            policy.render_raw_template(self.company)

    def test_10_protocol_mismatch_rejection(self):
        """Verify routing raw command with mismatched protocol raises ValidationError."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        with self.assertRaises(ValidationError):
            router.route_raw_command(
                "^XA^XZ",
                protocol="zpl",
                binding=self.primary_binding,  # primary_binding has escpos
                company=self.branch,
            )

    def test_11_intent_state_machine(self):
        """Verify illegal intent state transitions raise ValidationError."""
        model = self.env["ir.model"].search([], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "State Machine Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "test_event",
            "binding_id": self.primary_binding.id,
            "active": True,
        })
        intent = self.env["print_gateway.intent"].create({
            "intent_key": "sm_intent_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "test_event",
            "status": "dispatched",
        })
        with self.assertRaises(ValidationError):
            intent.write({"status": "pending"})

    def test_12_test_page_cutter_and_raw_banner(self):
        """Verify test page format for raw banner and ESC/POS cut handling."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        raw_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-raw",
            "printer_protocol": "raw",
            "enabled": True,
        })
        RouterClass = type(router)
        with patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = router.route_test_page(raw_binding)
            job = self.env["print_gateway.print_job"].browse(res["job_id"])
            self.assertEqual(job.protocol, "raw")
            self.assertIn("Protocol: RAW", job.raw_payload)
            self.assertNotIn("\x1b@", job.raw_payload)

    def test_13_action_rearm_intent(self):
        """Verify operator action_rearm_intent re-arms failed intents."""
        model = self.env["ir.model"].search([], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Rearm Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "test_event",
            "binding_id": self.primary_binding.id,
            "active": True,
        })
        intent = self.env["print_gateway.intent"].create({
            "intent_key": "rearm_intent_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "test_event",
            "status": "failed",
            "attempts": 3,
        })
        intent.action_rearm_intent()
        self.assertEqual(intent.status, "pending")
        self.assertEqual(intent.attempts, 0)

