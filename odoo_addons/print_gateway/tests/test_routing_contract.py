from unittest.mock import patch
import uuid

import requests

# Hard imports: this module only runs under the Odoo test runner; a fallback
# previously degraded the whole file into silent skips with a green exit.
from odoo import api
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase
from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig


class TestPrintGatewayRoutingContract(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company
        values = {
            "gateway_url": "https://gateway.example.com",
            "gateway_api_key": "odoo_test_key",
            "enabled": True,
        }
        with patch.object(PrintGatewayConfig, "_validate_gateway_host"):
            self.config = self.env["print_gateway.gateway_config"].search(
                [("company_id", "=", self.company.id)], limit=1
            )
            if self.config:
                self.config.write(values)
            else:
                self.config = self.env["print_gateway.gateway_config"].create(
                    {"company_id": self.company.id, **values}
                )

        # Durable fixtures are created and committed on one independent cursor.
        # They are only accessed from fresh cursors afterwards because Odoo test
        # transactions use a snapshot which does not see later commits.
        durable_company_name = "Gateway Durable Test %s" % uuid.uuid4().hex
        other_company_name = "Gateway Contract Other Company %s" % uuid.uuid4().hex
        cr = self.env.registry.cursor()
        try:
            setup_env = api.Environment(cr, self.env.uid, dict(self.env.context))
            durable_company = setup_env["res.company"].create({"name": durable_company_name})
            other_company = setup_env["res.company"].create({"name": other_company_name})
            with patch.object(PrintGatewayConfig, "_validate_gateway_host"):
                durable_config = setup_env["print_gateway.gateway_config"].create(
                    {
                        "company_id": durable_company.id,
                        **values,
                    }
                )
            self.durable_company_id = durable_company.id
            self.durable_config_id = durable_config.id
            self.other_company_id = other_company.id
            cr.commit()
        finally:
            cr.close()

    def _make_config(self, enabled=True):
        self.config.write({"enabled": enabled})
        return self.config

    def _job(self, key):
        """Create a durable job and return only its scalar id."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            if not company:
                raise AssertionError("Durable test company is not visible on fresh cursor")
            router = env["print_gateway.print_router"].with_company(company)
            config = env["print_gateway.gateway_config"].browse(self.durable_config_id).exists()
            if not config:
                raise AssertionError("Durable test gateway config is not visible on fresh cursor")
            job_id = router._persist_durable_job(
                {
                    "company": company,
                    "gateway_config": config,
                    "printer_id": "printer_runtime_%s" % key,
                    "destination": "Sales",
                    "document_type": "order",
                    "payload": {"type": "raw", "protocol": "raw", "encoding": "base64", "data": "aGVsbG8="},
                    "protocol": "raw",
                    "idempotency_key": key,
                }
            )
            return job_id
        finally:
            cr.close()

    def test_binding_requires_deterministic_native_destination(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        self.assertTrue(report)
        binding = self.env["print_gateway.binding"].create(
            {
                "company_id": self.company.id,
                "destination_type": "report",
                "destination_report_id": report.id,
                "report_id": report.id,
                "printer_id": "printer_runtime_1",
                "printer_protocol": "escpos",
                "enabled": True,
                "priority": 10,
            }
        )
        self.assertEqual(binding.destination_ref._name, "ir.actions.report")

    def test_binding_destination_reference_is_derived_from_native_destination(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        binding = self.env["print_gateway.binding"].create(
            {
                "company_id": self.company.id,
                "destination_type": "report",
                "destination_report_id": report.id,
                "report_id": report.id,
                "printer_id": "printer_runtime_1",
                "printer_protocol": "escpos",
            }
        )
        self.assertEqual(binding.destination_ref._name, "ir.actions.report")
        self.assertEqual(binding.destination_ref.id, report.id)

    def test_manual_destination_reference_cannot_override_derived_native_destination(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        other_report = self.env["ir.actions.report"].search(
            [("model", "=", "stock.picking"), ("id", "!=", report.id)], limit=1
        )
        self.assertTrue(
            other_report,
            "Expected another valid report destination in the Odoo test database.",
        )
        binding = self.env["print_gateway.binding"].create(
            {
                "company_id": self.company.id,
                "destination_type": "report",
                "destination_report_id": report.id,
                "report_id": report.id,
                "destination_ref": "ir.actions.report,%s" % other_report.id,
                "printer_id": "printer_runtime_1",
                "printer_protocol": "escpos",
            }
        )
        self.assertEqual(binding.destination_ref._name, "ir.actions.report")
        self.assertEqual(binding.destination_ref.id, report.id)

    def test_cross_company_destination_is_rejected(self):
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.company.id).exists()
            other_company = env["res.company"].browse(self.other_company_id).exists()
            self.assertTrue(company)
            self.assertTrue(other_company)
            model_env = env["stock.picking.type"].with_company(company).env
            picking_type = model_env["stock.picking.type"].search(
                [("company_id", "=", company.id)], limit=1
            )
            self.assertTrue(
                picking_type,
                "Expected at least one company-scoped stock operation type in the Odoo test database.",
            )
            report = model_env["ir.actions.report"].search(
                [("model", "=", "stock.picking")], limit=1
            )
            self.assertTrue(report, "Expected a stock picking report in the Odoo test database.")
            with self.assertRaises(ValidationError):
                model_env["print_gateway.binding"].create(
                    {
                        "company_id": other_company.id,
                        "destination_type": "picking_type",
                        "destination_picking_type_id": picking_type.id,
                        "report_id": report.id,
                        "printer_id": "printer_runtime_1",
                "printer_protocol": "escpos",
                    }
                )
        finally:
            cr.close()

    def test_document_type_is_deterministic_for_supported_business_models(self):
        router = self.env["print_gateway.print_router"]
        report_by_model = {
            "sale.order": self.env.ref("sale.action_report_saleorder", raise_if_not_found=False),
            "account.move": self.env["ir.actions.report"].search(
                [("model", "=", "account.move")], limit=1
            ),
            "stock.picking": self.env["ir.actions.report"].search(
                [("model", "=", "stock.picking")], limit=1
            ),
            "purchase.order": self.env["ir.actions.report"].search(
                [("model", "=", "purchase.order")], limit=1
            ),
        }
        expected = {
            "sale.order": "order",
            "account.move": "invoice",
            "stock.picking": "delivery",
            "purchase.order": "purchase_order",
        }
        for model_name, report in report_by_model.items():
            self.assertTrue(report, "No report available for %s" % model_name)
            self.assertEqual(router._document_type(report=report), expected[model_name])

    def test_router_fails_when_gateway_enabled_and_binding_missing(self):
        self._make_config(True)
        self.env["print_gateway.binding"].search(
            [("company_id", "=", self.company.id)]
        ).unlink()
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        with self.assertRaises(ValidationError):
            self.env["print_gateway.print_router"].resolve_binding(
                report=report, record=self.env["sale.order"]
            )

    def test_router_rejects_company_argument_that_is_not_active(self):
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            report = env["ir.actions.report"].search(
                [("model", "=", "sale.order")], limit=1
            )
            other_company = env["res.company"].browse(self.other_company_id).exists()
            self.assertTrue(report)
            self.assertTrue(other_company)
            with self.assertRaises(ValidationError):
                env["print_gateway.print_router"].resolve_binding(
                    report=report,
                    company=other_company,
                )
        finally:
            cr.close()

    def test_router_rejects_document_from_another_company_context(self):
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.company.id).exists()
            other_company = env["res.company"].browse(self.other_company_id).exists()
            self.assertTrue(company)
            self.assertTrue(other_company)
            model_env = env["res.partner"].with_company(company).env
            partner = model_env["res.partner"].create(
                {
                    "name": "Other Company Print Context",
                    "company_id": other_company.id,
                }
            )
            report = model_env["ir.actions.report"].search(
                [("model", "=", "sale.order")], limit=1
            )
            with self.assertRaises(ValidationError):
                model_env["print_gateway.print_router"].resolve_binding(
                    report=report,
                    record=partner,
                    document_type="order",
                    company=company,
                )
        finally:
            cr.close()

    def test_native_print_is_only_allowed_when_gateway_is_disabled(self):
        self._make_config(False)
        result = self.env["print_gateway.print_router"].resolve_binding(record=self.env.company)
        self.assertTrue(result["native"])

    def test_gateway_connection_test_is_authenticated(self):
        class Response:
            status_code = 200
            content = b'{"ok": true}'

            def json(self):
                return {"ok": True}

        with patch.object(PrintGatewayConfig, "_validate_gateway_host"), patch(
            "odoo.addons.print_gateway.models.gateway_config.requests.get",
            return_value=Response(),
        ) as mocked:
            self.config.action_test_connection()
            self.assertEqual(
                mocked.call_args.args[0],
                "https://gateway.example.com/api/odoo/health",
            )
            self.assertIn("Authorization", mocked.call_args.kwargs["headers"])
            self.assertEqual(mocked.call_args.kwargs["allow_redirects"], False)

    def test_gateway_timeout_persists_unknown_outcome(self):
        job_id = self._job("timeout-contract-key")
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            self.assertTrue(company)
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            self.assertTrue(job)
            with patch.object(PrintGatewayConfig, "_validate_gateway_host"), patch(
                "odoo.addons.print_gateway.models.print_job.requests.post",
                side_effect=requests.exceptions.Timeout("simulated"),
            ):
                with self.assertRaises(ValidationError):
                    job.action_submit(raise_on_failure=True)
        finally:
            cr.close()

        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            self.assertEqual(job.status, "unknown")
            self.assertIn("UNKNOWN_SUBMISSION_OUTCOME", job.last_error)
            self.assertFalse(job.next_retry_at)
        finally:
            cr.close()

    def test_cron_submit_pending_ignores_unknown_jobs(self):
        job_id = self._job("cron-safety-unknown")
        # Publish the unknown state through a separate COMMITTED cursor (the
        # same durable pattern _job itself uses), so the cron's verdict
        # cannot depend on same-transaction visibility subtleties: the row
        # is unknown to every reader before the cron runs.
        wcr = self.env.registry.cursor()
        try:
            wenv = api.Environment(wcr, self.env.uid, dict(self.env.context))
            wjob = wenv["print_gateway.print_job"].browse(job_id).exists()
            self.assertTrue(wjob, "durable job must be visible on a fresh cursor")
            wjob.write({"status": "unknown", "next_retry_at": False})
            wcr.commit()
        finally:
            wcr.close()
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            self.assertTrue(job, "durable job must be visible to the cron reader")
            job.invalidate_recordset()
            self.assertEqual(job.status, "unknown")

            with patch.object(type(job), "action_submit", autospec=True) as mocked_submit:
                model_env["print_gateway.print_job"].cron_submit_pending()
                mocked_submit.assert_not_called()
        finally:
            cr.close()

    def test_force_reprint_from_unknown_generates_derived_key(self):
        job_id = self._job("reprint-unknown-origin")
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            job.write({"status": "unknown", "next_retry_at": False})

            with patch.object(type(job), "action_submit", autospec=True, return_value=True) as mocked_submit:
                job.action_force_reprint()
                self.assertEqual(job.reprint_attempt_count, 1)
                derived_jobs = model_env["print_gateway.print_job"].search([
                    ("idempotency_key", "=", "%s-reprint-1" % job.idempotency_key),
                ])
                self.assertEqual(len(derived_jobs), 1)
                mocked_submit.assert_called_once()
        finally:
            cr.close()

    def test_manual_retry_does_not_reset_in_flight_or_unknown_jobs(self):
        # Fixture rows walk the canonical chain hop-by-hop (the matrix
        # forbids shortcuts even in tests): queued -> submitted -> claimed
        # -> printing, plus a terminal unknown row.
        chain = {
            "submitted": ("submitted",),
            "claimed": ("submitted", "claimed"),
            "printing": ("submitted", "claimed", "printing"),
            "unknown": None,
        }
        for status, hops in chain.items():
            job_id = self._job("retry-safety-%s" % status)
            cr = self.env.registry.cursor()
            try:
                env = api.Environment(cr, self.env.uid, dict(self.env.context))
                company = env["res.company"].browse(self.durable_company_id).exists()
                model_env = env["print_gateway.print_job"].with_company(company).env
                job = model_env["print_gateway.print_job"].browse(job_id).exists()
                if hops is None:
                    job.write({"status": "unknown", "next_retry_at": False})
                else:
                    for hop in hops:
                        job.write({"status": hop})
                job.action_retry()
                self.assertEqual(job.status, status)
            finally:
                cr.close()

    def test_manual_retry_creates_a_new_operation_only_for_definite_failure(self):
        job_id = self._job("retry-failed-original")
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            job.write({"status": "failed", "last_error": "GATEWAY_HTTP_503"})
            with patch.object(type(job), "action_submit", autospec=True, return_value=True) as submit:
                job.action_retry()
            retries = model_env["print_gateway.print_job"].search(
                [
                    ("id", "!=", job.id),
                    ("source_record_id", "=", False),
                    ("printer_id", "=", job.printer_id),
                    ("idempotency_key", "!=", job.idempotency_key),
                ]
            )
            self.assertEqual(len(retries), 1)
            self.assertNotEqual(retries.idempotency_key, job.idempotency_key)
            submit.assert_called_once()
        finally:
            cr.close()

    def test_gateway_unknown_outcome_marker_parity(self):
        """Cross-layer parity: unknown-outcome markers must match the Gateway
        (src/lib/job-status.ts) and the Go agent
        (agent/internal/printer/outcome.go) verbatim. A renamed marker in one
        layer silently converts ambiguous outcomes into auto-retryable
        failures in another (physical double prints)."""
        expected = (
            "AGENT_EXECUTION_TIMEOUT",
            "AGENT_RESTART_DURING_PRINT",
            "JOB_EXPIRED_DURING_PRINT",
            "UNKNOWN_PARTIAL_DELIVERY",
            "UNKNOWN_SUBMISSION_OUTCOME",
        )
        self.assertEqual(
            tuple(self.env["print_gateway.print_job"]._GATEWAY_UNKNOWN_MARKERS),
            expected,
        )

    def test_sync_maps_failed_with_unknown_markers_to_unknown(self):
        """BEHAVIORAL: a Gateway 'failed' whose error starts with any
        UNKNOWN_* marker must land in outbox status 'unknown' - never
        'failed' (which would read as definitely-not-printed and offer
        ordinary Retry) and never 'partial'. A markerless failed stays
        'failed'."""
        from unittest.mock import MagicMock
        markers = [
            "AGENT_EXECUTION_TIMEOUT",
            "AGENT_RESTART_DURING_PRINT",
            "JOB_EXPIRED_DURING_PRINT",
            "UNKNOWN_PARTIAL_DELIVERY",
            "UNKNOWN_SUBMISSION_OUTCOME",
        ]
        cases = [(m, "unknown") for m in markers]
        cases.append((None, "failed"))
        for marker, expected in cases:
            key = "sync-marker-%s" % (marker or "plain")
            job_id = self._job(key)
            cr = self.env.registry.cursor()
            try:
                env = api.Environment(cr, self.env.uid, dict(self.env.context))
                company = env["res.company"].browse(self.durable_company_id).exists()
                model_env = env["print_gateway.print_job"].with_company(company).env
                job = model_env["print_gateway.print_job"].browse(job_id).exists()
                job.write({"gateway_job_id": "gw-%s" % key, "status": "submitted"})
                mock_resp = MagicMock()
                mock_resp.status_code = 200
                if marker:
                    mock_resp.json.return_value = {
                        "status": "failed",
                        "error": "%s: simulated ambiguous execution" % marker,
                    }
                else:
                    mock_resp.json.return_value = {
                        "status": "failed",
                        "error": "CONNECTION_ERROR: simulated refused connection",
                    }
                with patch.object(PrintGatewayConfig, "_validate_gateway_host"), patch(
                    "odoo.addons.print_gateway.models.print_job.requests.get",
                    return_value=mock_resp,
                ):
                    job.action_sync_status()
                self.assertEqual(
                    job.status, expected,
                    "marker=%r must map to %r" % (marker, expected),
                )
            finally:
                cr.close()

    def test_sync_gateway_requeue_keeps_ahead_state_and_syncs_remaining_jobs(self):
        """A Gateway 'queued' observation while Odoo already holds 'claimed'
        is a normal lease event (stale-claim reclaim, evidence-push failure
        release, fenced pre-execution rejection) - NOT new information. The
        sync must keep the ahead state instead of writing backward (which
        the matrix forbids and which used to raise and abort the whole sync
        loop, starving every other job until the row converged)."""
        from unittest.mock import MagicMock
        first_id = self._job("sync-requeue-race-claimed")
        second_id = self._job("sync-requeue-race-submitted")
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            first = model_env["print_gateway.print_job"].browse(first_id).exists()
            second = model_env["print_gateway.print_job"].browse(second_id).exists()
            # Walk legal hops only: direct write() enforces the matrix.
            first.write({"gateway_job_id": "gw-requeue-race-1", "status": "submitted"})
            first.write({"status": "claimed"})
            second.write({"gateway_job_id": "gw-requeue-race-2", "status": "submitted"})

            def fake_get(url, params=None, **kwargs):
                resp = MagicMock()
                resp.status_code = 200
                if (params or {}).get("id") == "gw-requeue-race-1":
                    # Gateway requeued the lease after Odoo observed 'claimed'.
                    resp.json.return_value = {"status": "queued", "error": False}
                else:
                    resp.json.return_value = {"status": "success", "error": False}
                return resp

            with patch.object(PrintGatewayConfig, "_validate_gateway_host"), patch(
                "odoo.addons.print_gateway.models.print_job.requests.get",
                side_effect=fake_get,
            ):
                # Must not raise: previously this aborted the loop here.
                model_env["print_gateway.print_job"].browse([first_id, second_id]).exists().action_sync_status()
            # Ahead state kept (no backward write to 'submitted')...
            self.assertEqual(
                model_env["print_gateway.print_job"].browse(first_id).exists().status,
                "claimed",
            )
            # ...and the remaining job still converged (no loop starvation).
            self.assertEqual(
                model_env["print_gateway.print_job"].browse(second_id).exists().status,
                "success",
            )
        finally:
            cr.close()

    def test_force_reprint_does_not_consume_sequence_on_failed_create(self):
        job_id = self._job("reprint-sequence-safety")
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            job.write({"status": "unknown", "next_retry_at": False})
            self.assertEqual(job.reprint_attempt_count, 0)

            real_create = type(job).create_operation
            calls = {"n": 0}

            def flaky_create(model_self, **kwargs):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise ValidationError("simulated creation failure")
                return real_create(model_self, **kwargs)

            with patch.object(type(job), "create_operation", autospec=True, side_effect=flaky_create):
                with self.assertRaises(ValidationError):
                    job.action_force_reprint()
            job.invalidate_recordset()
            self.assertEqual(job.reprint_attempt_count, 0)
            self.assertFalse(model_env["print_gateway.print_job"].search([
                ("idempotency_key", "like", "%s-reprint-%%" % job.idempotency_key),
            ]))

            with patch.object(type(job), "action_submit", autospec=True, return_value=True):
                job.action_force_reprint()
            self.assertEqual(job.reprint_attempt_count, 1)
            derived = model_env["print_gateway.print_job"].search([
                ("idempotency_key", "=", "%s-reprint-1" % job.idempotency_key),
            ])
            self.assertEqual(len(derived), 1)
        finally:
            cr.close()
