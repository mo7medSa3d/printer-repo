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
import uuid
from unittest.mock import patch, MagicMock

# Hard imports: this module only runs under the Odoo test runner. A fallback
# to plain unittest previously turned every behavioral test into a silent
# skip while the suite still exited green.
from odoo import api
from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, ValidationError
from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig


class TestControlPlane(TransactionCase):

    def setUp(self):
        super().setUp()

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
            "priority": 10,
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
            "priority": 30,
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
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
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
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_pre_dispatch_failover_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })

        import requests

        def _refused_connection():
            # A pre-dispatch failure MUST carry a connect-phase cause
            # (connect refused): a bare ConnectionError without a proven
            # cause is ambiguous dispatch and must NOT fail over.
            exc = requests.exceptions.ConnectionError("Connection refused")
            exc.__cause__ = ConnectionRefusedError(111, "Connection refused")
            return exc

        # Mock requests.post: first call raises ConnectionError, second call succeeds
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_job_backup_123", "status": "queued"}

        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=[_refused_connection(), mock_resp]):
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
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
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

    def test_04b_midstream_connection_break_never_failovers(self):
        """A ConnectionError that is NOT provably connect-phase (e.g. a reset
        AFTER request bytes were sent) must be terminal-unknown: no failover
        (that would create a second print on the backup), no automatic retry."""
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Primary Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_midstream_reset_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })

        import requests
        broken = requests.exceptions.ConnectionError("Connection aborted")
        broken.__cause__ = ConnectionResetError(104, "Connection reset by peer")
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=broken):
            job.action_submit()
            self.assertEqual(job.status, "unknown")
            self.assertFalse(job.next_retry_at)
            self.assertEqual(job.printer_id, self.primary_binding.printer_id)
            self.assertIn("UNKNOWN_SUBMISSION_OUTCOME", job.last_error or "")

    def test_04c_connect_timeout_is_pre_dispatch_and_retries(self):
        """A connect-phase timeout proves zero bytes left the host: it is
        retryable with backoff and failover-eligible, unlike a read timeout."""
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Primary Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_connect_timeout_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })

        import requests

        class ConnectTimeoutError(Exception):
            pass

        exc = requests.exceptions.ConnectTimeout("Connection timed out")
        exc.__cause__ = ConnectTimeoutError()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_job_cto_123", "status": "queued"}
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=[exc, mock_resp]):
            job.action_submit()
            self.assertEqual(job.printer_id, self.backup_binding.printer_id)
            self.assertEqual(job.gateway_job_id, "gw_job_cto_123")

    def test_05_hardware_test_page_action(self):
        """Verify binding 'action_send_test_print' produces diagnostic outbox job."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        BindingClass = type(self.primary_binding)
        RouterClass = type(router)
        with patch.object(BindingClass, "_validate_runtime_target"), \
             patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            res = self.primary_binding.with_company(self.branch).action_send_test_print()
            self.assertEqual(res.get("type"), "ir.actions.client")
            self.assertEqual(res.get("tag"), "display_notification")
            route_res = router.route_test_page(self.primary_binding)
            self.assertTrue(route_res.get("gateway_enabled"))
            job = self.env["print_gateway.print_job"].browse(route_res.get("job_id"))
            self.assertEqual(job.protocol, "escpos")
            self.assertIn("ODOO PRINT GATEWAY DIAGNOSTIC", job.raw_payload)

    def test_06_intent_crash_recovery_cron(self):
        """Verify cron_recover_pending_intents recovers stale claimed or pending intents."""
        intent_model = self.env["print_gateway.intent"]
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Cron Recovery Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })
        intent = intent_model.create({
            "intent_key": "stale_intent_test_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "picking_validated",
            "status": "pending",
        })
        IntentClass = type(intent_model)
        with patch.object(IntentClass, "_execute_dispatched_route") as mock_exec, \
             patch.object(IntentClass, "_claim_intent", return_value="fake_token_123"):
            recovered = intent_model.cron_recover_pending_intents()
            self.assertGreaterEqual(recovered, 1)
            mock_exec.assert_called()

    def test_06b_cron_recovery_routes_branch_report_intents_under_their_own_company(self):
        """Cron recovery must route under the target record's company.

        The recovery cron runs under the cron user's default company. A
        branch-scoped REPORT intent previously hit `_assert_current_company`
        inside resolve_binding (record company != env.company), failed, and
        stranded permanently as `failed` after max_attempts - defeating the
        recovery cron for multi-branch setups. The raw_template branch never
        performed this assert, so only report intents were affected. The
        real contract: `_execute_dispatched_route` switches to the record's
        own company, so a branch report intent routes even when env.company
        is the root company.
        """
        intent_model = self.env["print_gateway.intent"]
        router = self.env["print_gateway.print_router"]
        picking_model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        picking_report = self.env["ir.actions.report"].search(
            [("model", "=", "stock.picking")], limit=1
        )
        self.assertTrue(picking_report, "A stock.picking report is required in the test database")
        branch_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": picking_report.id,
            "report_id": picking_report.id,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-branch-recovery",
            "printer_protocol": "escpos",
            "enabled": True,
            "priority": 5,
        })
        policy = self.env["print_gateway.policy"].create({
            "name": "Cron Recovery Branch Report Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": picking_model.id,
            "event_type": "picking_validated",
            "action_type": "report",
            "report_id": picking_report.id,
            "binding_id": branch_binding.id,
            "active": True,
        })
        picking_type = (
            self.env["stock.picking.type"].search([("company_id", "=", self.branch.id)], limit=1)
            or self.env["stock.picking.type"].search([], limit=1)
        )
        self.assertTrue(picking_type, "A stock.picking.type is required in the test database")
        picking = self.env["stock.picking"].create({
            "picking_type_id": picking_type.id,
            "location_id": picking_type.default_location_src_id.id,
            "location_dest_id": picking_type.default_location_dest_id.id,
        })
        self.assertEqual(picking.company_id, self.branch)
        intent = intent_model.create({
            "intent_key": "stale_branch_report_intent_key_01",
            "policy_id": policy.id,
            "res_model": picking_model.model,
            "res_id": picking.id,
            "event_type": "picking_validated",
            "status": "pending",
        })
        intent.write({"status": "claimed", "claim_token": "fake_token_branch_1"})
        # A real outbox row: print_job_id is a Many2one (integer column), so
        # the fenced finalize write must receive a durable row id.
        outbox_job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": branch_binding.printer_id,
            "destination": "Branch Recovery Destination",
            "document_type": "delivery",
            "status": "queued",
            "payload": json.dumps({"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_branch_recovery_key_01",
        })
        # Simulate the recovery cron: fresh env under the ROOT company
        # (the cron user's default), not the intent's branch company.
        root_env = self.env["stock.picking"].with_company(self.company).env
        RouterClass = type(router)
        with patch.object(RouterClass, "_render_pdf_payload", return_value={"type": "pdf", "encoding": "base64", "data": "dGVzdA=="}), \
             patch.object(RouterClass, "_submit_route", return_value={"job_id": outbox_job.id}) as mock_submit:
            type(intent_model)._execute_dispatched_route(
                root_env, intent.id, picking_model.model, picking.id, "fake_token_branch_1"
            )
            # The branch record routed successfully despite env.company
            # being the root company (the fix), and the intent was fenced
            # into the dispatched state with the job id.
            mock_submit.assert_called_once()
            intent.invalidate_recordset(["status", "print_job_id", "last_error"])
            self.assertEqual(intent.status, "dispatched")
            self.assertEqual(intent.print_job_id.id, outbox_job.id)

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
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_cycle_safety_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })
        import requests
        # The cycle guard must be exercised by REAL failovers, so the
        # failure proves pre-dispatch (connect refused); an ambiguous
        # failure would rightly never enter the failover loop at all.
        refused = requests.exceptions.ConnectionError("Connection refused")
        refused.__cause__ = ConnectionRefusedError(111, "Connection refused")
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=refused):
            # Must terminate gracefully, not hang in recursion
            job.action_submit()
            self.assertIn(job.status, ("failed", "queued"))

    def test_07b_failover_chain_bounded_depth(self):
        """A->B->C engages (each hop re-proven pre-dispatch); a fourth hop
        is never attempted: depth is bounded AND revisited printers are
        skipped, so the chain always terminates."""
        chain_c = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": self.primary_binding.destination_report_id.id,
            "report_id": self.primary_binding.report_id.id,
            "printer_protocol": "escpos",
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-chain-c",
            "enabled": True,
            "priority": 10,
            "fallback_binding_id": False,
        })
        chain_d = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": self.primary_binding.destination_report_id.id,
            "report_id": self.primary_binding.report_id.id,
            "printer_protocol": "escpos",
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-chain-d",
            "enabled": True,
            "priority": 5,
            "fallback_binding_id": False,
        })
        chain_c.fallback_binding_id = chain_d.id
        self.backup_binding.fallback_binding_id = chain_c.id
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Chain Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_chain_depth_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })
        import requests

        def _refused():
            exc = requests.exceptions.ConnectionError("Connection refused")
            exc.__cause__ = ConnectionRefusedError(111, "Connection refused")
            return exc

        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=[_refused(), _refused(), _refused(), _refused()]) as mock_post:
            job.action_submit()
            # A->backup->C->D all engaged (3 failovers = MAX depth); a fifth
            # hop is never attempted: exactly 4 HTTP attempts happened.
            self.assertEqual(mock_post.call_count, 4)
            self.assertEqual(job.printer_id, "printer-chain-d")
            self.assertEqual(job.status, "queued")
            self.assertTrue(job.next_retry_at, "Backoff retry is scheduled after the depth cap")

    def test_08_raw_command_idempotency_and_authorization(self):
        """Verify route_raw_command accepts explicit idempotency key and enforces binding validation."""
        router = self.env["print_gateway.print_router"].with_company(self.branch)
        RouterClass = type(router)
        disabled_binding = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": self.primary_binding.destination_report_id.id,
            "report_id": self.primary_binding.report_id.id,
            "printer_protocol": "escpos",
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-disabled",
            "enabled": False,
            "priority": 99,
        })
        with self.assertRaises(ValidationError):
            router.route_raw_command(
                "^XA^XZ",
                protocol="zpl",
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
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Template Error Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "Hello {non_existent_field_xyz}!",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })
        mock_picking = MagicMock()
        mock_picking._fields = {}
        with self.assertRaises(ValidationError):
            policy.render_raw_template(mock_picking)
            
        policy.raw_template = "Hello {name.__class__}"
        with self.assertRaisesRegex(ValidationError, "forbidden in raw print templates"):
            policy.render_raw_template(mock_picking)

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
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "State Machine Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })
        intent = self.env["print_gateway.intent"].create({
            "intent_key": "sm_intent_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "picking_validated",
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
            "destination_report_id": self.primary_binding.destination_report_id.id,
            "report_id": self.primary_binding.report_id.id,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-raw",
            "printer_protocol": "raw",
            "enabled": True,
            "priority": 40,
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
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Rearm Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })
        intent = self.env["print_gateway.intent"].create({
            "intent_key": "rearm_intent_key_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "picking_validated",
            "status": "failed",
            "attempts": 3,
        })
        intent.action_rearm_intent()
        self.assertEqual(intent.status, "pending")
        self.assertEqual(intent.attempts, 0)

    def test_14_intent_single_claim_recovery_and_fencing(self):
        """Verify single-claim intent recovery lifecycle and fencing token lease protection."""
        import datetime
        from odoo import fields
        intent_model = self.env["print_gateway.intent"]
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Single Claim Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })

        # 1. Pending intent acquires claim token
        intent_pending = intent_model.create({
            "intent_key": "intent_claim_test_pending_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 1,
            "event_type": "picking_validated",
            "status": "pending",
        })
        token_pending = intent_model._claim_intent(self.env, intent_pending.id, cr=self.env.cr)
        self.assertTrue(bool(token_pending), "Pending intent must be claimed atomically")
        intent_pending.invalidate_recordset()
        self.assertEqual(intent_pending.status, "claimed")
        self.assertEqual(intent_pending.claim_token, token_pending)

        # 2. Fresh claimed intent must NOT be claimed again (suppress duplicate processing)
        token_fresh = intent_model._claim_intent(self.env, intent_pending.id, cr=self.env.cr)
        self.assertIsNone(token_fresh, "Fresh claimed intent must reject duplicate lease acquisition")

        # 3. Stale claimed intent (> 5 min) can be recovered
        stale_time = fields.Datetime.now() - datetime.timedelta(minutes=10)
        self.env.cr.execute(
            "UPDATE print_gateway_intent SET claimed_at = %s WHERE id = %s",
            (stale_time, intent_pending.id)
        )
        token_stale = intent_model._claim_intent(self.env, intent_pending.id, cr=self.env.cr)
        self.assertTrue(bool(token_stale), "Stale claimed intent must be recovered")
        self.assertNotEqual(token_stale, token_pending, "Recovered intent must receive a new fencing token")

        # 4. Fencing token protection: Stale worker attempting to finalize state with superseded token fails
        updated_stale = intent_model._finalize_intent_state(
            self.env, intent_pending.id, token_pending, "dispatched", cr=self.env.cr
        )
        self.assertFalse(updated_stale, "Stale worker token must be fenced and rejected")

        # Valid worker finalize succeeds
        updated_valid = intent_model._finalize_intent_state(
            self.env, intent_pending.id, token_stale, "dispatched", cr=self.env.cr
        )
        self.assertTrue(updated_valid, "Valid current token must successfully finalize state")
        intent_pending.invalidate_recordset()
        self.assertEqual(intent_pending.status, "dispatched")

        # 5. Terminal failed intent (attempts >= max_attempts) is NOT claimed
        intent_terminal = intent_model.create({
            "intent_key": "intent_claim_test_terminal_01",
            "policy_id": policy.id,
            "res_model": model.model,
            "res_id": 2,
            "event_type": "picking_validated",
            "status": "failed",
            "attempts": 3,
            "max_attempts": 3,
        })
        token_terminal = intent_model._claim_intent(self.env, intent_terminal.id, cr=self.env.cr)
        self.assertIsNone(token_terminal, "Terminal failed intent must not be automatically claimed")

    def test_15_multi_record_report_routing_scope_isolation(self):
        """Verify /report/download rejects mixed-scope batches and enforces IDOR permissions."""
        from odoo.addons.print_gateway.controllers.report_download_override import PrintGatewayReportController
        from odoo.exceptions import AccessError
        from werkzeug.wrappers import Response as WerkzeugResponse

        controller = PrintGatewayReportController()
        report = self.env["ir.actions.report"].search([("model", "=", "stock.picking")], limit=1)
        if not report:
            report = self.env["ir.actions.report"].create({
                "name": "Test Picking Report",
                "model": "stock.picking",
                "report_type": "qweb-pdf",
                "report_name": "test.picking_report",
            })

        PickingClass = type(self.env[report.model])

        # Fake request context
        mock_req = MagicMock()
        mock_req.env = self.env
        mock_req.make_response = lambda data, headers=None, status=200: WerkzeugResponse(data, status=status, headers=headers)

        with patch("odoo.addons.print_gateway.controllers.report_download_override.request", mock_req):
            # Test 1: Empty docids returns 400
            data_empty = json.dumps([f"/report/pdf/{report.report_name}/", "qweb-pdf"])
            resp = controller.report_download(data_empty)
            self.assertEqual(resp.status_code, 400)
            self.assertIn("invalid_report_request", resp.get_data(as_text=True))

            # Test 2: Unknown report returns 404
            data_bad_rep = json.dumps(["/report/pdf/nonexistent.report/1,2", "qweb-pdf"])
            resp = controller.report_download(data_bad_rep)
            self.assertEqual(resp.status_code, 404)
            self.assertIn("report_not_found", resp.get_data(as_text=True))

            # Test 3: Mixed scope / different bindings returns 400 mixed_scope_batch
            mock_records = MagicMock()
            mock_records.__len__.return_value = 2
            mock_records.exists.return_value = mock_records
            mock_records.check_access.return_value = None
            rec1, rec2 = MagicMock(), MagicMock()
            mock_records.__iter__.return_value = [rec1, rec2]

            router = self.env["print_gateway.print_router"]
            RouterClass = type(router)
            route1 = {
                "binding": self.primary_binding,
                "binding_id": self.primary_binding.id,
                "printer_id": self.primary_binding.printer_id,
                "runtime_agent_id": self.primary_binding.runtime_agent_id,
                "gateway_enabled": True,
                "native": False,
            }
            route2 = {
                "binding": self.zpl_binding,
                "binding_id": self.zpl_binding.id,
                "printer_id": self.zpl_binding.printer_id,
                "runtime_agent_id": self.zpl_binding.runtime_agent_id,
                "gateway_enabled": True,
                "native": False,
            }

            with patch.object(PickingClass, "browse", return_value=mock_records), \
                 patch.object(RouterClass, "resolve_binding", side_effect=[route1, route2]):
                data_mixed = json.dumps([f"/report/pdf/{report.report_name}/1,2", "qweb-pdf"])
                resp = controller.report_download(data_mixed)
                self.assertEqual(resp.status_code, 400)
                self.assertIn("mixed_scope_batch", resp.get_data(as_text=True))

            # Test 4: Access error returns 403 forbidden without leaking internals
            with patch.object(PickingClass, "browse", return_value=mock_records), \
                 patch.object(mock_records, "check_access", side_effect=AccessError("No read access")):
                data_forbidden = json.dumps([f"/report/pdf/{report.report_name}/1,2", "qweb-pdf"])
                resp = controller.report_download(data_forbidden)
                self.assertEqual(resp.status_code, 403)
                self.assertIn("forbidden", resp.get_data(as_text=True))
                self.assertNotIn("No read access", resp.get_data(as_text=True))

            # Test 5: Gateway dispatch failure returns 502 without leaking raw trace
            with patch.object(PickingClass, "browse", return_value=mock_records), \
                 patch.object(mock_records, "check_access", return_value=None), \
                 patch.object(RouterClass, "resolve_binding", return_value=route1), \
                 patch.object(RouterClass, "route_report", side_effect=RuntimeError("Internal gateway timeout")):
                data_dispatch = json.dumps([f"/report/pdf/{report.report_name}/1,2", "qweb-pdf"])
                resp = controller.report_download(data_dispatch)
                self.assertEqual(resp.status_code, 502)
                self.assertIn("gateway_dispatch_failed", resp.get_data(as_text=True))
                self.assertNotIn("Internal gateway timeout", resp.get_data(as_text=True))

    def test_16_migration_canonical_root_placeholder(self):
        """Verify 19.0.2.1.0 migration creates disabled non-routable placeholder when root binding is missing."""
        import importlib.util
        import os
        migration_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "migrations", "19.0.2.1.0", "post-migrate.py"))
        spec = importlib.util.spec_from_file_location("post_migrate", migration_path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)

        executed_sqls = []
        mock_cr = MagicMock()
        mock_cr.execute.side_effect = lambda sql, *args: executed_sqls.append(sql)
        mock_cr.fetchone.return_value = ("runtime_agent_id",)

        migration.migrate(mock_cr, "19.0.2.1.0")

        # Verify SQL checks b.branch_id IS NULL specifically
        insert_sql = next((sql for sql in executed_sqls if "INSERT INTO print_gateway_binding" in sql), "")
        self.assertIn("b.branch_id IS NULL", insert_sql, "Migration must check for missing root binding specifically")
        self.assertIn("'unassigned'", insert_sql, "Migration must use 'unassigned' placeholder rather than fake routable printer")
        self.assertIn("FALSE", insert_sql, "Migration placeholder binding must be explicitly disabled")

    def test_17_policy_validation_constraints(self):
        """Verify strict policy validation for event/model pairs, mutual exclusivity, and domain fields."""
        model_picking = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        model_partner = self.env["ir.model"].search([("model", "=", "res.partner")], limit=1)

        # 1. Invalid model / event pairing rejected
        with self.assertRaises(ValidationError):
            self.env["print_gateway.policy"].create({
                "name": "Invalid Event Model",
                "company_id": self.company.id,
                "model_id": model_partner.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_template": "^XA^XZ",
                "raw_protocol": "zpl",
            })

        # 2. Mutual exclusivity: action_type == 'report' rejects raw_template
        report = self.env["ir.actions.report"].search([("model", "=", "stock.picking")], limit=1)
        with self.assertRaises(ValidationError):
            self.env["print_gateway.policy"].create({
                "name": "Report with Raw Template",
                "company_id": self.company.id,
                "model_id": model_picking.id,
                "event_type": "picking_validated",
                "action_type": "report",
                "report_id": report.id if report else False,
                "raw_template": "^XA^XZ",
            })

        # 3. Mutual exclusivity: action_type == 'raw_template' rejects report_id
        with self.assertRaises(ValidationError):
            self.env["print_gateway.policy"].create({
                "name": "Raw with Report",
                "company_id": self.company.id,
                "model_id": model_picking.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "report_id": report.id if report else False,
                "raw_template": "^XA^XZ",
                "raw_protocol": "zpl",
            })

        # 4. Incompatible binding protocol rejected
        with self.assertRaises(ValidationError):
            self.env["print_gateway.policy"].create({
                "name": "Incompatible Binding Protocol",
                "company_id": self.company.id,
                "model_id": model_picking.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_template": "^XA^XZ",
                "raw_protocol": "zpl",
                "binding_id": self.primary_binding.id,  # primary_binding has escpos protocol
            })

        # 5. Invalid field in domain filter rejected
        with self.assertRaises(ValidationError):
            self.env["print_gateway.policy"].create({
                "name": "Invalid Domain Field",
                "company_id": self.company.id,
                "model_id": model_picking.id,
                "event_type": "picking_validated",
                "action_type": "raw_template",
                "raw_template": "^XA^XZ",
                "raw_protocol": "zpl",
                "binding_id": self.zpl_binding.id,
                "domain_filter": "[('non_existent_field_on_picking', '=', True)]",
            })

    def test_18_binding_dispatch_report_action_logger_exception(self):
        """Verify dispatch_report_action exception path logs warning and fails closed without NameError."""
        report = self.primary_binding.report_id
        if not report:
            self.skipTest("No report fixture available")
        BindingClass = type(self.primary_binding)
        with patch.object(BindingClass, "find_for", side_effect=RuntimeError("Simulated database failure")), \
             patch("odoo.addons.print_gateway.models.binding._logger.warning") as mock_warn:
            res = self.env["print_gateway.binding"].dispatch_report_action(
                report_name=report.report_name,
                res_ids=[1],
            )
            self.assertFalse(res.get("dispatched"))
            self.assertFalse(res.get("success"))
            self.assertTrue(res.get("fail_closed"))
            mock_warn.assert_called_once()

    def test_19_peripherals_validation(self):
        """Verify peripheral validation: PDF/raster reject active peripherals, normalize none."""
        job_pdf = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "PDF Dest",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({
                "type": "pdf",
                "encoding": "base64",
                "data": "JVBERi0xLjQK",
                "peripherals": {"drawer": "none", "cutter": "none", "buzzer": "none"},
            }),
            "idempotency_key": "test_periph_pdf_none_01",
        })
        body = job_pdf._submission_body()
        self.assertNotIn("peripherals", body["payload"], "Empty/none peripherals must be normalized away for PDF")

        job_pdf_active = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "PDF Dest",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({
                "type": "pdf",
                "encoding": "base64",
                "data": "JVBERi0xLjQK",
                "peripherals": {"drawer": "pin2"},
            }),
            "idempotency_key": "test_periph_pdf_active_01",
        })
        with self.assertRaises(ValidationError):
            job_pdf_active._submission_body()

    def test_20_report_download_fail_closed_on_config_error(self):
        """Verify report_download fails closed (502) if _gateway_config raises or is invalid."""
        from odoo.addons.print_gateway.controllers.report_download_override import PrintGatewayReportController
        from odoo.http import Response
        ctrl = PrintGatewayReportController()
        req_data = json.dumps(["/report/pdf/test.report/1", "qweb-pdf"])
        mock_req = MagicMock()
        mock_req.env = self.env
        mock_req.make_response = MagicMock(side_effect=lambda content, headers, status: Response(content, status=status, headers=headers))
        RouterClass = type(self.env["print_gateway.print_router"])
        with patch("odoo.addons.print_gateway.controllers.report_download_override.request", mock_req), \
             patch.object(RouterClass, "_gateway_config", side_effect=RuntimeError("Gateway unreachable")):
            resp = ctrl.report_download(req_data)
            self.assertEqual(resp.status_code, 502)
            content = json.loads(resp.get_data(as_text=True))
            self.assertEqual(content.get("error"), "gateway_dispatch_failed")

    def test_21_raw_payload_requires_explicit_protocol(self):
        """Verify raw payload creation strictly requires explicit printer protocol without fallback inference."""
        with self.assertRaises(ValidationError):
            self.env["print_gateway.print_job"].create({
                "company_id": self.branch.id,
                "gateway_config_id": self.gateway_config.id,
                "printer_id": self.primary_binding.printer_id,
                "destination": "Raw Dest",
                "document_type": "label",
                "status": "queued",
                "payload": json.dumps({"type": "raw", "data": "dGVzdA=="}),
                "idempotency_key": "test_no_proto_key_01",
            })

    def test_22_queued_to_success_idempotent_replay(self):
        """Verify action_submit safely records terminal success when Gateway returns replayed idempotent job."""
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Replay Dest",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_idempotent_replay_success_01",
        })
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_replayed_123", "status": "success"}
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", return_value=mock_resp):
            job.action_submit()
            self.assertEqual(job.status, "success")
            self.assertEqual(job.physical_outcome, "printed")
            self.assertEqual(job.gateway_job_id, "gw_replayed_123")



    def _operator_user(self):
        """A normal print operator: internal user, no settings rights, no
        outbox rights - the identity every production print flow runs as."""
        user = self.env["res.users"].create({
            "name": "Print Operator ACL",
            "login": "print_operator_acl_%s" % self.branch.id,
            "company_id": self.branch.id,
            "company_ids": [(6, 0, [self.branch.id])],
        })
        self.assertFalse(user.has_group("base.group_system"))
        return user

    def test_25_normal_user_close_outbox_rights_are_read_only(self):
        """The outbox model intentionally grants normal users read-only ACLs;
        direct writes must fail closed (this is the invariant the service
        boundary exists to preserve)."""
        user = self._operator_user()
        with self.assertRaises(AccessError):
            self.env["print_gateway.print_job"].with_user(user).check_access("create")
        with self.assertRaises(AccessError):
            self.env["print_gateway.print_job"].with_user(user).check_access("write")

    def test_26_normal_user_full_print_flow_succeeds_through_service_boundary(self):
        """BEHAVIORAL: an operator with NO outbox rights routes a raw command
        end-to-end. The create/submit elevation happens inside the trusted
        server-side boundary (create_operation + submit), never via the
        user's raw model rights.

        Runs within TransactionCase isolation: the operator user is passed
        through create_operation and _action_submit_trusted to prove that the
        service boundary elevates internally without AccessError for users
        who have zero direct outbox create/write rights (proven by test_25 and
        verified below). Standalone cursor visibility is tested by test_26b.
        """
        user = self._operator_user()
        self.assertFalse(user.has_group("base.group_system"))
        with self.assertRaises(AccessError):
            self.env["print_gateway.print_job"].with_user(user).check_access("create")
        with self.assertRaises(AccessError):
            self.env["print_gateway.print_job"].with_user(user).check_access("write")

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_operator_123", "status": "queued"}
        RouterClass = type(self.env["print_gateway.print_router"])
        router = self.env["print_gateway.print_router"].with_user(user).with_company(self.branch)

        def _operator_persist_job(values):
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
            model = self.env["print_gateway.print_job"].with_user(user)
            if target_company:
                model = model.with_company(target_company)
            job = model.create_operation(**durable_values)
            return job.id

        def _operator_submit_job(job_id):
            job = self.env["print_gateway.print_job"].with_user(user).browse(job_id)
            with self.assertRaises(AccessError):
                job.action_submit()
            job._action_submit_trusted(raise_on_failure=True)
            return job.status

        with patch.object(RouterClass, "_persist_durable_job", side_effect=_operator_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", side_effect=_operator_submit_job), \
             patch.object(PrintGatewayConfig, "_validate_gateway_host", return_value=None), \
             patch("requests.post", return_value=mock_resp):
            res = router.route_raw_command(
                "\x1b@Operator ticket",
                protocol="escpos",
                binding=self.primary_binding,
                company=self.branch,
                document_type="receipt",
                idempotency_key="test_operator_flow_key_01",
            )
        self.assertTrue(res.get("gateway_enabled"))
        job = self.env["print_gateway.print_job"].browse(res["job_id"])
        self.assertTrue(job.exists())
        self.assertEqual(job.status, "submitted")
        self.assertEqual(job.gateway_job_id, "gw_operator_123")
        self.assertEqual(job.company_id, self.branch)

    def test_26b_persist_refuses_records_invisible_to_its_own_cursor(self):
        """BEHAVIORAL transaction-visibility regression test: the durable
        persist path runs on an independent cursor, so rows created but not
        yet committed in the caller transaction MUST be refused with a clear
        error - never silently operated on, and never resolved from stale
        in-memory records. Standalone requests (committed bindings/configs)
        and post-commit intent dispatch are unaffected."""
        router = self.env["print_gateway.print_router"]
        with self.assertRaises(ValidationError) as ctx:
            router._persist_durable_job({
                "company": self.branch,
                "gateway_config": self.gateway_config,
                "printer_id": "printer-visibility",
                "destination": "Visibility Desk",
                "document_type": "label",
                "payload": {"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="},
                "idempotency_key": "test_visibility_key_01",
            })
        self.assertIn("no longer available", str(ctx.exception))
        # And a wholesale-missing record fails the same existence gate
        # (proving the check is the visibility gate, not an ACL accident).
        ghost_company = self.env["res.company"].browse(999999999)
        with self.assertRaises(ValidationError):
            router._persist_durable_job({
                "company": ghost_company,
                "gateway_config": self.gateway_config,
                "printer_id": "printer-visibility",
                "destination": "Visibility Desk",
                "document_type": "label",
                "payload": {"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="},
                "idempotency_key": "test_visibility_key_02",
            })

    def test_27_create_operation_is_not_reachable_via_rpc(self):
        """BEHAVIORAL (real RPC dispatch gate): every remote call_kw in Odoo
        resolves through odoo.service.model.call_kw -> get_public_method,
        which raises AccessError for methods carrying @api.private. Driving
        that exact gate proves create_operation() cannot be invoked remotely
        by ANY user, so forged outbox rows (arbitrary printer/protocol/data)
        cannot be created remotely. A public operator action passes the same
        gate (row-level ACLs are enforced separately, not here)."""
        from odoo.service.model import get_public_method
        user = self._operator_user()
        with self.assertRaises(AccessError):
            get_public_method(self.env["print_gateway.print_job"].with_user(user), "create_operation")
        with self.assertRaises(AccessError):
            get_public_method(self.env["print_gateway.print_job"], "create_operation")
        self.assertTrue(callable(get_public_method(self.env["print_gateway.print_job"], "action_retry")))

    def test_28_operator_retry_and_direct_create_stay_fail_closed(self):
        """BEHAVIORAL: operator actions that change outbox state still
        require real write rights; direct ORM create without rights fails.
        Only the trusted boundary may mint rows."""
        user = self._operator_user()
        with self.assertRaises(AccessError):
            self.env["print_gateway.print_job"].with_user(user).create({
                "company_id": self.branch.id,
                "gateway_config_id": self.gateway_config.id,
                "printer_id": self.primary_binding.printer_id,
                "destination": "Forged Dest",
                "document_type": "label",
                "status": "queued",
                "payload": json.dumps({"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="}),
                "idempotency_key": "test_forged_key_01",
            })
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Retry Guard Dest",
            "document_type": "label",
            "status": "failed",
            "payload": json.dumps({"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_retry_guard_key_01",
        })
        with self.assertRaises(AccessError):
            job.with_user(user).action_retry()

    def test_29_test_ticket_sanitizers_neutralize_command_injection(self):
        """Pure-function contract: company/printer metadata embedded into
        ZPL/TSPL/ESC-POS tickets cannot inject commands or escape arguments."""
        from odoo.addons.print_gateway.models.print_router import (
            _zpl_text, _tspl_text, _escpos_text,
        )
        hostile = 'ACME^XZ\n^XA^FO1,1^FDOWNED^FS^XZ~HQES"INJ\x1b@X'
        zpl = _zpl_text(hostile)
        self.assertNotIn("^", zpl)
        self.assertNotIn("~", zpl)
        self.assertNotIn("\x1b", zpl)
        self.assertIn("ACME", zpl)
        tspl = _tspl_text(hostile)
        self.assertNotIn('"', tspl)
        self.assertNotIn("\x1b", tspl)
        esc = _escpos_text(hostile)
        self.assertNotIn("\x1b", esc)
        self.assertNotIn("\n", esc)
        # Normal names pass through untouched.
        self.assertEqual(_zpl_text("Warehouse 12 - Berlin"), "Warehouse 12 - Berlin")

    def test_03b_failover_rejects_incompatible_protocol(self):
        """Failover requires EXACT protocol parity: an escpos job must NOT
        fail over to a zpl-only backup (that would send garbage to label
        hardware). The job stays queued with backoff for operator action."""
        incompatible = self.env["print_gateway.binding"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "destination_type": "report",
            "destination_report_id": self.primary_binding.destination_report_id.id,
            "report_id": self.primary_binding.report_id.id,
            "runtime_agent_id": "agent-cp-01",
            "printer_id": "printer-zpl-backup",
            "printer_protocol": "zpl",
            "enabled": True,
            "priority": 15,
            "fallback_binding_id": False,
        })
        job = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Primary Destination",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_failover_incompatible_key_01",
            "fallback_binding_id": incompatible.id,
        })

        import requests
        refused = requests.exceptions.ConnectionError("Connection refused")
        refused.__cause__ = ConnectionRefusedError(111, "Connection refused")
        ConfigClass = type(self.gateway_config)
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", side_effect=refused):
            job.action_submit()
            self.assertEqual(job.printer_id, self.primary_binding.printer_id,
                             "Incompatible backup must never receive the job")
            self.assertEqual(job.status, "queued")
            self.assertTrue(job.next_retry_at, "Backoff retry is scheduled")
            self.assertIn("CONNECTION_ERROR", job.last_error or "")

    def test_01b_business_rollback_discards_intent_and_dispatch(self):
        """The durable print intent is committed ATOMICALLY with the
        originating business transaction: if the business work rolls back,
        the intent row vanishes AND the registered post-commit dispatch is
        discarded (Odoo drops postcommit hooks added inside a rolled-back
        savepoint). No orphan intent may survive to print later."""
        model = self.env["ir.model"].search([("model", "=", "stock.picking")], limit=1)
        if not model:
            model = self.env["ir.model"].search([], limit=1)
        policy = self.env["print_gateway.policy"].create({
            "name": "Rollback Atomicity Policy",
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "model_id": model.id,
            "event_type": "picking_validated",
            "action_type": "raw_template",
            "raw_template": "^XA^FD{name}^FS^XZ",
            "raw_protocol": "zpl",
            "binding_id": self.zpl_binding.id,
            "active": True,
        })
        mock_picking = MagicMock()
        mock_picking._name = model.model
        mock_picking.id = 9993
        mock_picking.company_id = self.branch
        mock_picking.write_date = "2026-09-08 16:00:00"

        intent_model = self.env["print_gateway.intent"]
        key = intent_model.compute_intent_key(policy, mock_picking, "picking_validated")
        self.assertFalse(intent_model.search([("intent_key", "=", key)]))
        with patch.object(type(intent_model), "_dispatch_intent_postcommit") as mocked_dispatch:
            try:
                with self.env.cr.savepoint():
                    intent_model.create_and_route(policy, mock_picking, "picking_validated")
                    self.assertTrue(
                        intent_model.search([("intent_key", "=", key)]),
                        "intent must be visible inside the business transaction",
                    )
                    raise RuntimeError("simulated business rollback")
            except RuntimeError:
                pass
            mocked_dispatch.assert_not_called()
        self.assertFalse(
            intent_model.search([("intent_key", "=", key)]),
            "rolled-back business work must leave no orphan intent",
        )

    def test_04d_deterministic_failures_terminalize_without_retry(self):
        """Validation/contract failures can never succeed on retry: a
        corrupted persisted payload and a contract-violating Gateway reply
        must terminalize immediately (failed, no next_retry_at) instead of
        burning five backoff attempts on identical bytes."""
        import requests
        ConfigClass = type(self.gateway_config)

        corrupted = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Corrupt Dest",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_deterministic_corrupt_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })
        corrupted.write({"payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "!!!not-base64!!!"})})
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post") as mock_post:
            corrupted.action_submit()
            mock_post.assert_not_called()
            self.assertEqual(corrupted.status, "failed")
            self.assertEqual(corrupted.attempts, 1)
            self.assertFalse(corrupted.next_retry_at)
            self.assertEqual(corrupted.printer_id, self.primary_binding.printer_id)

        garbage = self.env["print_gateway.print_job"].create({
            "company_id": self.branch.id,
            "gateway_config_id": self.gateway_config.id,
            "printer_id": self.primary_binding.printer_id,
            "destination": "Garbage Dest",
            "document_type": "invoice",
            "status": "queued",
            "payload": json.dumps({"type": "escpos", "protocol": "escpos", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_deterministic_garbage_key_01",
            "fallback_binding_id": self.backup_binding.id,
        })
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"unexpected": "shape"}
        with patch.object(ConfigClass, "_validate_gateway_host", return_value=None), \
             patch("requests.post", return_value=mock_resp):
            garbage.action_submit()
            self.assertEqual(garbage.status, "failed")
            self.assertEqual(garbage.attempts, 1)
            self.assertFalse(garbage.next_retry_at)
            self.assertIn("GATEWAY_INVALID_RESPONSE", garbage.last_error or "")

    def test_30_direct_binding_enforces_resolution_scope_parity(self):
        """Direct binding= must satisfy the EXACT same scope model as
        find_for() resolution: same-branch allow; sibling-branch reject;
        root-context with branch binding reject; branch-context with root
        binding allow (documented fallback); cross-company reject. A manual
        binding must never bypass the scopes resolution would enforce."""
        report_id = self.primary_binding.destination_report_id.id
        sibling_branch = self.env["res.company"].create({
            "name": "Control Plane Sibling Branch",
            "parent_id": self.company.id,
        })
        other_company = self.env["res.company"].create({"name": "Control Plane Other Co"})

        # Priorities start above the setUpClass fixtures (10/20/30): the
        # UNIQUE(company_id, branch_id, destination_ref, document_type,
        # priority) constraint would collide with primary_binding otherwise.
        pri_counter = [50]

        def _binding(company, branch, printer, protocol="escpos"):
            pri_counter[0] += 1
            return self.env["print_gateway.binding"].create({
                "company_id": company.id,
                "branch_id": branch.id if branch else False,
                "destination_type": "report",
                "destination_report_id": report_id,
                "report_id": report_id,
                "runtime_agent_id": "agent-scope-%s" % printer,
                "printer_id": printer,
                "printer_protocol": protocol,
                "enabled": True,
                "priority": pri_counter[0],
            })

        branch_binding = _binding(self.company, self.branch, "printer-scope-branch")
        sibling_binding = _binding(self.company, sibling_branch, "printer-scope-sibling")
        root_binding = _binding(self.company, False, "printer-scope-root")
        other_binding = _binding(other_company, False, "printer-scope-other")

        router = self.env["print_gateway.print_router"].with_company(self.branch)
        RouterClass = type(router)

        def _route(company, binding):
            with patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
                 patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
                return router.route_raw_command(
                    "\x1b@Scope probe",
                    protocol="escpos",
                    binding=binding,
                    company=company,
                    document_type="receipt",
                    idempotency_key="test_scope_%s_%s" % (company.id, binding.id),
                )

        # Same branch: the binding find_for would resolve here.
        self.assertTrue(_route(self.branch, branch_binding).get("gateway_enabled"))
        # Manually supplied binding works the same as a resolved one.
        self.assertTrue(_route(self.branch, branch_binding).get("gateway_enabled"))
        # Sibling branch: find_for from branchA never selects branchB rows.
        with self.assertRaises(ValidationError):
            _route(self.branch, sibling_binding)
        # Branch operation with a root binding: allowed, mirroring find_for's
        # documented (company, branch=False) fallback.
        self.assertTrue(_route(self.branch, root_binding).get("gateway_enabled"))
        # Root operation with a branch binding: find_for from the root only
        # searches branch=False, so this is rejected.
        root_router = self.env["print_gateway.print_router"].with_company(self.company)
        with patch.object(RouterClass, "_persist_durable_job", side_effect=self._fake_persist_job), \
             patch.object(RouterClass, "_submit_durable_job", return_value="submitted"):
            with self.assertRaises(ValidationError):
                root_router.route_raw_command(
                    "\x1b@Scope probe",
                    protocol="escpos",
                    binding=branch_binding,
                    company=self.company,
                    document_type="receipt",
                    idempotency_key="test_scope_root_branch",
                )
        # Another company entirely: rejected.
        with self.assertRaises(ValidationError):
            _route(self.branch, other_binding)
