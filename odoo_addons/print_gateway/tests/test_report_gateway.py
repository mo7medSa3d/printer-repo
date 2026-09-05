# -*- coding: utf-8 -*-
import base64
import json
from unittest.mock import MagicMock, patch

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestReportGateway(TransactionCase):

    def setUp(self):
        super().setUp()
        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Test Branch',
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_123',
            'enabled': True,
        })
        self.dest_pos = self.env['print_gateway.destination'].create({
            'name': 'POS 1', 'branch_id': self.branch.id,
            'destination_type': 'pos', 'enabled': True,
        })
        self.doc_order = self.env['print_gateway.document_type'].create({
            'name': 'order', 'branch_id': self.branch.id, 'enabled': True,
        })
        self.agent = self.env['print_gateway.agent'].create({
            'gateway_agent_id': 'agt_test_123', 'name': 'Test Agent',
            'branch_id': self.branch.id,
        })
        self.printer = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_test_123', 'name': 'Test Printer',
            'agent_id': self.agent.id, 'status': 'online',
        })
        self.binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch.id, 'destination_id': self.dest_pos.id,
            'document_type_id': self.doc_order.id, 'printer_id': self.printer.id,
            'priority': 1, 'enabled': True,
        })

    def test_unconfigured_report_fallback(self):
        report = self.env['ir.actions.report'].create({
            'name': 'Test Unconfigured Report',
            'model': 'res.partner',
            'report_name': 'test.unconfigured_report',
            'report_type': 'qweb-pdf',
        })
        self.assertFalse(report._should_route_via_gateway())

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_direct_create_print_job_remains_synchronous_for_non_report_payloads(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            'jobId': 'job_test_123',
            'status': 'queued',
            'printerId': self.printer.gateway_printer_id,
        }
        mock_post.return_value = mock_resp
        payload = {'type': 'raw', 'encoding': 'base64', 'data': base64.b64encode(b'test').decode()}
        job = self.branch.create_print_job(self.dest_pos.id, 'order', payload, odoo_model='sale.order', odoo_record_id=42, report_xml_id='sale.action_report_saleorder', report_name='sale.report_saleorder')
        self.assertEqual(job.gateway_job_id, 'job_test_123')
        self.assertEqual(job.status, 'queued')
        self.assertTrue(mock_post.called)

    def test_gateway_report_action_only_persists_render_descriptor(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest('sale.action_report_saleorder not found')
        report.write({'print_gateway_enabled': True, 'print_gateway_document_type_id': self.doc_order.id})
        partner = self.env['res.partner'].create({'name': 'Async Test Partner'})
        try:
            order = self.env['sale.order'].create({'partner_id': partner.id})
        except Exception:
            self.skipTest('Cannot create sale order')
        with patch.object(type(report), '_determine_branch', return_value=self.branch), \
             patch.object(type(report), '_determine_destination', return_value=self.dest_pos), \
             patch.object(type(report), '_determine_document_type', return_value='order'), \
             patch.object(type(report), '_render_qweb_pdf') as mock_render, \
             patch('odoo.addons.print_gateway.models.branch.requests.post') as mock_post:
            action = report.report_action(order.id, data={'test': True})
        mock_render.assert_not_called()
        mock_post.assert_not_called()
        self.assertEqual(action['type'], 'ir.actions.client')
        job = self.env['print_gateway.print_job'].search([('branch_id', '=', self.branch.id), ('odoo_record_id', '=', order.id)], order='id desc', limit=1)
        self.assertTrue(job)
        self.assertFalse(job.gateway_job_id)
        descriptor = json.loads(job.payload)
        self.assertEqual(descriptor['kind'], 'odoo_report_render')
        self.assertEqual(descriptor['report_id'], report.id)
        self.assertEqual(descriptor['res_ids'], [order.id])
        self.assertEqual(descriptor['data'], {'test': True})
        report.write({'print_gateway_enabled': False})

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_pending_report_worker_renders_then_submits_real_pdf(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {'jobId': 'job_pdf_async_test', 'status': 'queued', 'printerId': self.printer.gateway_printer_id}
        mock_post.return_value = mock_resp
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest('sale.action_report_saleorder not found')
        report.write({'print_gateway_enabled': True, 'print_gateway_document_type_id': self.doc_order.id})
        partner = self.env['res.partner'].create({'name': 'Async PDF Partner'})
        try:
            order = self.env['sale.order'].create({'partner_id': partner.id})
        except Exception:
            self.skipTest('Cannot create sale order')
        job = self.env['print_gateway.print_job'].create({
            'branch_id': self.branch.id,
            'destination_id': self.dest_pos.id,
            'document_type': 'order',
            'status': 'queued',
            'idempotency_key': 'async-pdf-test-key',
            'odoo_model': 'sale.order',
            'odoo_record_id': order.id,
            'report_id': report.id,
            'report_name': report.report_name,
            'payload': json.dumps({'kind': 'odoo_report_render', 'report_id': report.id, 'model': 'sale.order', 'res_ids': [order.id], 'data': None}, separators=(',', ':')),
        })
        with patch.object(type(report), '_render_qweb_pdf', return_value=(b'%PDF-1.4 async test', 'pdf')):
            self.assertTrue(job.action_submit_pending())
        self.assertTrue(mock_post.called)
        request_payload = mock_post.call_args[1]['json']
        self.assertEqual(request_payload['idempotencyKey'], 'async-pdf-test-key')
        decoded = base64.b64decode(request_payload['payload']['data'])
        self.assertTrue(decoded.startswith(b'%PDF'))
        self.assertEqual(job.gateway_job_id, 'job_pdf_async_test')
        self.assertNotIn('odoo_report_render', job.payload)
        report.write({'print_gateway_enabled': False})

    def test_pending_report_render_failure_keeps_operation_durable(self):
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest('sale.action_report_saleorder not found')
        job = self.env['print_gateway.print_job'].create({
            'branch_id': self.branch.id,
            'destination_id': self.dest_pos.id,
            'document_type': 'order',
            'status': 'queued',
            'idempotency_key': 'render-failure-test-key',
            'odoo_model': 'sale.order',
            'report_id': report.id,
            'payload': json.dumps({'kind': 'odoo_report_render', 'report_id': report.id, 'model': report.model, 'res_ids': [999999999], 'data': None}, separators=(',', ':')),
        })
        with patch.object(type(report), '_generate_payload_for_report', side_effect=ValidationError('render failed')):
            self.assertFalse(job.action_submit_pending())
        self.assertFalse(job.gateway_job_id)
        self.assertEqual(job.status, 'queued')
        self.assertIn('render failed', job.error)
        self.assertEqual(job.idempotency_key, 'render-failure-test-key')

    def test_idempotency_key_is_stable_for_existing_operation(self):
        job = self.env['print_gateway.print_job'].create({'branch_id': self.branch.id, 'destination_id': self.dest_pos.id, 'document_type': 'order', 'status': 'queued', 'idempotency_key': 'stable-key'})
        found = self.env['print_gateway.print_job'].search([('branch_id', '=', self.branch.id), ('idempotency_key', '=', 'stable-key')], limit=1)
        self.assertEqual(found.id, job.id)
