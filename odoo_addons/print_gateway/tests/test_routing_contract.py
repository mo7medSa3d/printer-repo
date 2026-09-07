from unittest.mock import patch

import requests

from odoo import api
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase

from odoo.addons.print_gateway.models.gateway_config import PrintGatewayConfig


class TestPrintGatewayRoutingContract(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.other_company = cls.env['res.company'].create({'name': 'Gateway Contract Other Company'})

        with patch.object(PrintGatewayConfig, '_validate_gateway_host'):
            with cls.env.registry.cursor() as cr:
                env = api.Environment(cr, cls.env.uid, dict(cls.env.context))
                config = env['print_gateway.gateway_config'].create({
                    'company_id': cls.company.id,
                    'gateway_url': 'https://gateway.example.com',
                    'gateway_api_key': 'odoo_test_key',
                    'enabled': True,
                })
                cls.config_id = config.id
                cr.commit()
        cls.config = cls.env['print_gateway.gateway_config'].browse(cls.config_id)

    @classmethod
    def tearDownClass(cls):
        config_id = getattr(cls, 'config_id', False)
        if config_id:
            with cls.env.registry.cursor() as cr:
                env = api.Environment(cr, cls.env.uid, dict(cls.env.context))
                env['print_gateway.print_job'].search([('gateway_config_id', '=', config_id)]).unlink()
                env['print_gateway.gateway_config'].browse(config_id).unlink()
                cr.commit()
        super().tearDownClass()

    def _make_config(self, enabled=True):
        config = self.env['print_gateway.gateway_config'].browse(self.config_id)
        config.invalidate_recordset(['enabled'])
        config.enabled = enabled
        return config

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
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            config = env['print_gateway.gateway_config'].browse(self.config_id)
            class Response:
                status_code = 200
                content = b'{"ok": true}'
                def json(self):
                    return {'ok': True}
            with patch.object(PrintGatewayConfig, '_validate_gateway_host'), patch(
                'odoo.addons.print_gateway.models.gateway_config.requests.get', return_value=Response()
            ) as mocked:
                config.action_test_connection()
                self.assertEqual(mocked.call_args.args[0], 'https://gateway.example.com/api/odoo/health')
                self.assertIn('Authorization', mocked.call_args.kwargs['headers'])
                self.assertEqual(mocked.call_args.kwargs['allow_redirects'], False)
            cr.commit()

    def test_gateway_timeout_persists_unknown_outcome(self):
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            router = env['print_gateway.print_router']
            config = env['print_gateway.gateway_config'].browse(self.config_id)
            job = router._persist_durable_job({
                'company': env.company,
                'gateway_config': config,
                'printer_id': 'printer_runtime_1',
                'destination': 'Sales',
                'document_type': 'order',
                'payload': {'type': 'raw', 'encoding': 'base64', 'data': 'aGVsbG8='},
                'idempotency_key': 'timeout-contract-key',
            })
            with patch.object(PrintGatewayConfig, '_validate_gateway_host'), patch(
                'odoo.addons.print_gateway.models.print_job.requests.post',
                side_effect=requests.exceptions.Timeout('simulated'),
            ):
                with self.assertRaises(ValidationError):
                    job.action_submit(raise_on_failure=True)
            job.invalidate_recordset(['status', 'last_error', 'attempts', 'next_retry_at'])
            persisted = env['print_gateway.print_job'].browse(job.id).exists()
            persisted.invalidate_recordset(['status', 'last_error'])
            self.assertEqual(persisted.status, 'unknown')
            self.assertIn('UNKNOWN_SUBMISSION_OUTCOME', persisted.last_error)
            cr.commit()
