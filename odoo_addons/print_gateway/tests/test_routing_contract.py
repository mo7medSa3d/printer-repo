from unittest.mock import patch
import uuid

import requests

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
        with self.env.registry.cursor() as cr:
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

    def _make_config(self, enabled=True):
        self.config.write({"enabled": enabled})
        return self.config

    def _job(self, key):
        """Create a durable job and return only its scalar id."""
        with self.env.registry.cursor() as cr:
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
                    "payload": {"type": "raw", "encoding": "base64", "data": "aGVsbG8="},
                    "idempotency_key": key,
                }
            )
        return job_id

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
            }
        )
        self.assertEqual(binding.destination_ref._name, "ir.actions.report")
        self.assertEqual(binding.destination_ref.id, report.id)

    def test_cross_company_destination_is_rejected(self):
        with self.env.registry.cursor() as cr:
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
                    }
                )

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
        with self.env.registry.cursor() as cr:
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

    def test_router_rejects_document_from_another_company_context(self):
        with self.env.registry.cursor() as cr:
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
        with self.env.registry.cursor() as cr:
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

        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            self.assertEqual(job.status, "unknown")
            self.assertIn("UNKNOWN_SUBMISSION_OUTCOME", job.last_error)
            self.assertFalse(job.next_retry_at)

    def test_cron_submit_pending_ignores_unknown_jobs(self):
        job_id = self._job("cron-safety-unknown")
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            company = env["res.company"].browse(self.durable_company_id).exists()
            model_env = env["print_gateway.print_job"].with_company(company).env
            job = model_env["print_gateway.print_job"].browse(job_id).exists()
            job.write({"status": "unknown", "next_retry_at": False})

            with patch.object(type(job), "action_submit", autospec=True) as mocked_submit:
                model_env["print_gateway.print_job"].cron_submit_pending()
                mocked_submit.assert_not_called()

    def test_force_reprint_from_unknown_generates_derived_key(self):
        job_id = self._job("reprint-unknown-origin")
        with self.env.registry.cursor() as cr:
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

    def test_manual_retry_does_not_reset_in_flight_or_unknown_jobs(self):
        for status in ("submitted", "claimed", "printing", "unknown"):
            job_id = self._job("retry-safety-%s" % status)
            with self.env.registry.cursor() as cr:
                env = api.Environment(cr, self.env.uid, dict(self.env.context))
                company = env["res.company"].browse(self.durable_company_id).exists()
                model_env = env["print_gateway.print_job"].with_company(company).env
                job = model_env["print_gateway.print_job"].browse(job_id).exists()
                job.write({"status": status})
                job.action_retry()
                self.assertEqual(job.status, status)

    def test_manual_retry_creates_a_new_operation_only_for_definite_failure(self):
        job_id = self._job("retry-failed-original")
        with self.env.registry.cursor() as cr:
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