from unittest.mock import patch

import requests

from odoo import api
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase

from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig


class TestPrintGatewayRoutingContract(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.other_company = self.env['res.company'].create({'name': 'Gateway Contract Other Company'})
        # The durable outbox intentionally writes through a separate transaction.
        # Reuse an already committed company config when another TransactionCase
        # execution has created it, otherwise create it exactly once.
        values = {
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_key',
            'enabled': True,
        }
        with self.env.registry.cursor() as cr:
            setup_env = api.Environment(cr, self.env.uid, dict(self.env.context))
            with patch.object(PrintGatewayConfig, '_validate_gateway_host'):
                config = setup_env['print_gateway.gateway_config'].search([
                    ('company_id', '=', self.company.id),
                ], limit=1)
                if config:
                    config.write(values)
                else:
                    config = setup_env['print_gateway.gateway_config'].create({
                        'company_id': self.company.id,
                        **values,
                    })
            config_id = config.id
            cr.commit()
        self.config = self.env['print_gateway.gateway_config'].browse(config_id)

    def _make_config(self, enabled=True):
        self.env['print_gateway.gateway_config'].search([
            ('company_id', '=', self.company.id),
            ('id', '!=', self.config.id),
        ]).write({'enabled': False})
        self.config.enabled = enabled
        return self.config

    def _job(self, key):
        router = self.env['print_gateway.print_router']
        job = router._persist_durable_job({
            'company': self.company,
            'gateway_config': self.config,
            'printer_id': 'printer_runtime_1',
            'destination': 'Sales',
            'document_type': 'order',
            'payload': {'type': 'raw', 'encoding': 'base64', 'data': 'aGVsbG8='},
            'idempotency_key': key,
        })
        self.env.invalidate_all()
        return self.env['print_gateway.print_job'].browse(job.id)

    def test_binding_requires_deterministic_native_destination(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        self.assertTrue(report)
        binding = self.env['print_gateway.binding'].create({
            'company_id': self.company.id,
            'destination_type': 'report',
            'destination_report_id': report.id,
            'report_id': report.id,
            'printer_id': 'printer_runtime_1',
            'enabled': True,
            'priority': 10,
        })
        self.assertEqual(binding.destination_ref._name, 'ir.actions.report')

    def test_binding_destination_reference_is_derived_from_native_destination(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        binding = self.env['print_gateway.binding'].create({
            'company_id': self.company.id,
            'destination_type': 'report',
            'destination_report_id': report.id,
            'report_id': report.id,
            'printer_id': 'printer_runtime_1',
        })
        self.assertEqual(binding.destination_ref._name, 'ir.actions.report')
        self.assertEqual(binding.destination_ref.id, report.id)

    def test_manual_destination_reference_cannot_override_derived_native_destination(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        other_report = self.env['ir.actions.report'].search([
            ('model', '=', 'stock.picking'),
            ('id', '!=', report.id),
        ], limit=1)
        self.assertTrue(other_report, 'Expected another valid report destination in the Odoo test database.')
        binding = self.env['print_gateway.binding'].create({
            'company_id': self.company.id,
            'destination_type': 'report',
            'destination_report_id': report.id,
            'report_id': report.id,
            'destination_ref': 'ir.actions.report,%s' % other_report.id,
            'printer_id': 'printer_runtime_1',
        })
        self.assertEqual(binding.destination_ref._name, 'ir.actions.report')
        self.assertEqual(binding.destination_ref.id, report.id)

    def test_cross_company_destination_is_rejected(self):
        picking_type = self.env['stock.picking.type'].search([('company_id', '=', self.company.id)], limit=1)
        self.assertTrue(picking_type, 'Expected at least one company-scoped stock operation type in the Odoo test database.')
        report = self.env['ir.actions.report'].search([('model', '=', 'stock.picking')], limit=1)
        self.assertTrue(report, 'Expected a stock picking report in the Odoo test database.')
        with self.assertRaises(ValidationError):
            self.env['print_gateway.binding'].create({
                'company_id': self.other_company.id,
                'destination_type': 'picking_type',
                'destination_picking_type_id': picking_type.id,
                'report_id': report.id,
                'printer_id': 'printer_runtime_1',
            })

    def test_document_type_is_deterministic_for_supported_business_models(self):
        router = self.env['print_gateway.print_router']
        report_by_model = {
            'sale.order': self.env.ref('sale.action_report_saleorder', raise_if_not_found=False),
            'account.move': self.env['ir.actions.report'].search([('model', '=', 'account.move')], limit=1),
            'stock.picking': self.env['ir.actions.report'].search([('model', '=', 'stock.picking')], limit=1),
            'purchase.order': self.env['ir.actions.report'].search([('model', '=', 'purchase.order')], limit=1),
        }
        expected = {
            'sale.order': 'order',
            'account.move': 'invoice',
            'stock.picking': 'delivery',
            'purchase.order': 'purchase_order',
        }
        for model_name, report in report_by_model.items():
            self.assertTrue(report, 'No report available for %s' % model_name)
            self.assertEqual(router._document_type(report=report), expected[model_name])

    def test_router_fails_when_gateway_enabled_and_binding_missing(self):
        self._make_config(True)
        self.env['print_gateway.binding'].search([('company_id', '=', self.company.id)]).unlink()
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        with self.assertRaises(ValidationError):
            self.env['print_gateway.print_router'].resolve_binding(report=report, record=self.env['sale.order'])

    def test_router_rejects_company_argument_that_is_not_active(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        with self.assertRaises(ValidationError):
            self.env['print_gateway.print_router'].resolve_binding(
                report=report,
                company=self.other_company,
            )

    def test_router_rejects_document_from_another_company_context(self):
        partner = self.env['res.partner'].create({
            'name': 'Other Company Print Context',
            'company_id': self.other_company.id,
        })
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        with self.assertRaises(ValidationError):
            self.env['print_gateway.print_router'].resolve_binding(
                report=report,
                record=partner,
                document_type='order',
                company=self.company,
            )

    def test_native_print_is_only_allowed_when_gateway_is_disabled(self):
        self._make_config(False)
        result = self.env['print_gateway.print_router'].resolve_binding(record=self.env.company)
        self.assertTrue(result['native'])

    def test_gateway_connection_test_is_authenticated(self):
        class Response:
            status_code = 200
            content = b'{"ok": true}'
            def json(self):
                return {'ok': True}

        with patch.object(PrintGatewayConfig, '_validate_gateway_host'), patch(
            'odoo.addons.print_gateway.models.gateway_config.requests.get', return_value=Response()
        ) as mocked:
            self.config.action_test_connection()
            self.assertEqual(mocked.call_args.args[0], 'https://gateway.example.com/api/odoo/health')
            self.assertIn('Authorization', mocked.call_args.kwargs['headers'])
            self.assertEqual(mocked.call_args.kwargs['allow_redirects'], False)

    def test_gateway_timeout_persists_unknown_outcome(self):
        job = self._job('timeout-contract-key')
        with patch.object(PrintGatewayConfig, '_validate_gateway_host'), patch(
            'odoo.addons.print_gateway.models.print_job.requests.post',
            side_effect=requests.exceptions.Timeout('simulated'),
        ):
            with self.assertRaises(ValidationError):
                job.action_submit(raise_on_failure=True)
        job.invalidate_recordset(['status', 'last_error', 'attempts', 'next_retry_at'])
        self.assertEqual(job.status, 'unknown')
        self.assertIn('UNKNOWN_SUBMISSION_OUTCOME', job.last_error)

    def test_manual_retry_does_not_reset_in_flight_or_unknown_jobs(self):
        for status in ('submitted', 'claimed', 'printing', 'unknown'):
            job = self._job('retry-safety-%s' % status)
            job.write({'status': status})
            job.action_retry()
            job.invalidate_recordset(['status'])
            self.assertEqual(job.status, status)

    def test_manual_retry_creates_a_new_operation_only_for_definite_failure(self):
        job = self._job('retry-failed-original')
        job.write({'status': 'failed', 'last_error': 'GATEWAY_HTTP_503'})
        with patch.object(type(job), 'action_submit', autospec=True, return_value=True) as submit:
            job.action_retry()
        retries = self.env['print_gateway.print_job'].search([
            ('id', '!=', job.id),
            ('source_record_id', '=', False),
            ('printer_id', '=', job.printer_id),
            ('idempotency_key', '!=', job.idempotency_key),
        ])
        self.assertEqual(len(retries), 1)
        self.assertNotEqual(retries.idempotency_key, job.idempotency_key)
        submit.assert_called_once()
