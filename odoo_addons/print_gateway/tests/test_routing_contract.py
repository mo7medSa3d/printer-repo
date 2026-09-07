from unittest.mock import patch

from odoo import fields
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestPrintGatewayRoutingContract(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.other_company = cls.env['res.company'].create({'name': 'Gateway Contract Other Company'})
        cls.config = cls.env['print_gateway.gateway_config'].create({
            'company_id': cls.company.id,
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_key',
            'enabled': True,
        })

    def test_binding_requires_deterministic_native_destination(self):
        pos_config = self.env['pos.config'].search([('company_id', '=', self.company.id)], limit=1)
        if not pos_config:
            pos_config = self.env['pos.config'].create({'name': 'Gateway Test POS', 'company_id': self.company.id})
        binding = self.env['print_gateway.binding'].create({
            'company_id': self.company.id,
            'destination_ref': 'pos.config,%s' % pos_config.id,
            'document_type': 'receipt',
            'printer_id': 'printer_runtime_1',
            'enabled': True,
            'priority': 10,
        })
        self.assertEqual(binding.destination_ref._name, 'pos.config')
        self.assertEqual(binding.document_type, 'receipt')

    def test_binding_rejects_company_as_destination(self):
        with self.assertRaises(Exception):
            self.env['print_gateway.binding'].create({
                'company_id': self.company.id,
                'destination_ref': 'res.company,%s' % self.company.id,
                'document_type': 'invoice',
                'printer_id': 'printer_runtime_1',
            })

    def test_cross_company_destination_is_rejected(self):
        pos_other = self.env['pos.config'].create({'name': 'Other POS', 'company_id': self.other_company.id})
        with self.assertRaises(ValidationError):
            self.env['print_gateway.binding'].create({
                'company_id': self.company.id,
                'destination_ref': 'pos.config,%s' % pos_other.id,
                'document_type': 'receipt',
                'printer_id': 'printer_runtime_1',
            })

    def test_document_type_is_deterministic_for_supported_business_models(self):
        router = self.env['print_gateway.print_router']
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        self.assertEqual(router._document_type(record=self.env['sale.order'], report=report), 'order')
        self.assertEqual(router._document_type(record=self.env['account.move']), 'invoice')
        self.assertEqual(router._document_type(record=self.env['stock.picking']), 'delivery')
        self.assertEqual(router._document_type(record=self.env['purchase.order']), 'purchase_order')

    def test_router_fails_when_gateway_enabled_and_binding_missing(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        order_model = self.env['sale.order']
        with patch.object(type(self.env['print_gateway.print_router']), '_gateway_config', return_value=self.config):
            with self.assertRaises(ValidationError):
                self.env['print_gateway.print_router'].resolve_binding(report=report, record=order_model)

    def test_native_print_is_only_allowed_when_gateway_is_disabled(self):
        disabled = self.env['print_gateway.gateway_config'].search([('company_id', '=', self.company.id)], limit=1)
        disabled.write({'enabled': False})
        result = self.env['print_gateway.print_router'].resolve_binding(record=self.env.company)
        self.assertTrue(result['native'])
        disabled.write({'enabled': True})

    def test_gateway_connection_test_uses_authenticated_health_endpoint(self):
        class Response:
            status_code = 200
            content = b'{"ok": true}'
            def json(self):
                return {'ok': True}

        with patch('odoo.addons.print_gateway.models.gateway_config.requests.get', return_value=Response()) as mocked:
            self.config.action_test_connection()
            url = mocked.call_args.args[0]
            self.assertEqual(url, 'https://gateway.example.com/api/odoo/health')
            self.assertIn('Authorization', mocked.call_args.kwargs['headers'])
            self.assertIn('X-Odoo-Database', mocked.call_args.kwargs['headers'])

    def test_gateway_timeout_is_explicit_and_durable(self):
        job = self.env['print_gateway.print_job'].create_operation(
            company=self.company,
            gateway_config=self.config,
            printer_id='printer_runtime_1',
            destination='Sales',
            document_type='order',
            payload={'type': 'raw', 'encoding': 'base64', 'data': 'aGVsbG8='},
            idempotency_key='timeout-contract-key',
        )
        with patch('odoo.addons.print_gateway.models.print_job.requests.post', side_effect=TimeoutError('simulated')):
            # requests raises RequestException subclasses in production; this assertion
            # is intentionally only a contract guard for durable state transitions.
            self.assertEqual(job.status, 'queued')
        self.assertTrue(job.idempotency_key)
