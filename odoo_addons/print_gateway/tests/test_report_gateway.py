# -*- coding: utf-8 -*-
from odoo.tests.common import TransactionCase
from odoo.exceptions import UserError
from unittest.mock import patch, MagicMock
import base64

class TestReportGateway(TransactionCase):

    def setUp(self):
        super().setUp()
        # Create branch
        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Test Branch',
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_123',
            'enabled': True,
        })
        # Create destinations
        self.dest_pos = self.env['print_gateway.destination'].create({
            'name': 'POS 1',
            'branch_id': self.branch.id,
            'destination_type': 'pos',
            'enabled': True,
        })
        self.dest_kitchen = self.env['print_gateway.destination'].create({
            'name': 'Kitchen',
            'branch_id': self.branch.id,
            'destination_type': 'kitchen',
            'enabled': True,
        })
        # Create document types
        self.doc_receipt = self.env['print_gateway.document_type'].create({
            'name': 'receipt',
            'branch_id': self.branch.id,
            'enabled': True,
        })
        self.doc_invoice = self.env['print_gateway.document_type'].create({
            'name': 'invoice',
            'branch_id': self.branch.id,
            'enabled': True,
        })
        self.doc_order = self.env['print_gateway.document_type'].create({
            'name': 'order',
            'branch_id': self.branch.id,
            'enabled': True,
        })
        self.doc_delivery = self.env['print_gateway.document_type'].create({
            'name': 'delivery',
            'branch_id': self.branch.id,
            'enabled': True,
        })
        # Create printer
        self.printer = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_test_123',
            'name': 'Test Printer',
            'branch_id': self.branch.id,
            'status': 'online',
            'enabled': True,
        })
        # Create binding
        self.binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch.id,
            'destination_id': self.dest_pos.id,
            'document_type_id': self.doc_order.id,
            'printer_id': self.printer.id,
            'priority': 1,
            'enabled': True,
        })

    def test_sale_order_report_mapping(self):
        """A. Sale Order report → Gateway"""
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest("sale.action_report_saleorder not found")
        mapping = self.env['print_gateway.report_mapping'].create({
            'report_id': report.id,
            'document_type_id': self.doc_order.id,
            'branch_id': self.branch.id,
            'destination_id': self.dest_pos.id,
            'gateway_enabled': True,
            'payload_type': 'pdf',
        })
        found = self.env['print_gateway.report_mapping'].get_mapping_for_report(report)
        self.assertEqual(found.id, mapping.id)
        self.assertTrue(report._should_route_via_gateway())

    def test_invoice_report_mapping(self):
        """B. Invoice report → Gateway"""
        report = self.env.ref('account.account_invoices', raise_if_not_found=False)
        if not report:
            # Try alternative
            report = self.env['ir.actions.report'].search([('model', '=', 'account.move')], limit=1)
            if not report:
                self.skipTest("No invoice report found")
        mapping = self.env['print_gateway.report_mapping'].create({
            'report_id': report.id,
            'document_type_id': self.doc_invoice.id,
            'gateway_enabled': True,
        })
        found = self.env['print_gateway.report_mapping'].get_mapping_for_report(report)
        self.assertEqual(found.id, mapping.id)

    def test_delivery_picking_report_mapping(self):
        """C. Delivery/Picking report → Gateway"""
        report = self.env.ref('stock.action_report_delivery', raise_if_not_found=False)
        if not report:
            report = self.env['ir.actions.report'].search([('model', '=', 'stock.picking')], limit=1)
            if not report:
                self.skipTest("No picking report found")
        mapping = self.env['print_gateway.report_mapping'].create({
            'report_id': report.id,
            'document_type_id': self.doc_delivery.id,
            'gateway_enabled': True,
        })
        self.assertTrue(report._should_route_via_gateway())

    def test_purchase_order_report_mapping(self):
        """D. Purchase Order report → Gateway"""
        report = self.env.ref('purchase.action_report_purchase_order', raise_if_not_found=False)
        if not report:
            report = self.env['ir.actions.report'].search([('model', '=', 'purchase.order')], limit=1)
            if not report:
                self.skipTest("No purchase report found")
        mapping = self.env['print_gateway.report_mapping'].create({
            'report_id': report.id,
            'document_type_name': 'purchase_order',
            'gateway_enabled': True,
        })
        self.assertTrue(report._should_route_via_gateway())

    def test_unconfigured_report_fallback(self):
        """E. Unconfigured report → normal Odoo behavior"""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Unconfigured Report',
            'model': 'res.partner',
            'report_name': 'test.unconfigured_report',
            'report_type': 'qweb-pdf',
        })
        self.assertFalse(report._should_route_via_gateway())
        # Ensure report_action would fallback to super (normal)
        # We don't call super here, just check logic

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_unavailable_failure(self, mock_post):
        """F. Gateway unavailable → correct failure, no false success"""
        mock_post.side_effect = Exception("Connection refused")
        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest("sale report not found")
        # Enable gateway for this report
        report.write({'print_gateway_enabled': True, 'print_gateway_document_type_id': self.doc_order.id})
        # Create a sale order to get a record
        partner = self.env['res.partner'].create({'name': 'Test Partner'})
        # Minimal sale order
        try:
            order = self.env['sale.order'].create({
                'partner_id': partner.id,
            })
        except Exception:
            self.skipTest("Cannot create sale order")
        # Mock _render_qweb_pdf to avoid needing full report
        with patch.object(type(report), '_render_qweb_pdf', return_value=(b'%PDF-1.4 test', 'pdf')):
            with self.assertRaises(UserError) as cm:
                report.report_action(order.id)
            self.assertIn('Gateway', str(cm.exception) or 'Failed' in str(cm.exception))
        report.write({'print_gateway_enabled': False})

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_returns_job_id(self, mock_post):
        """G. Gateway returns job ID → Print Job created"""
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {'jobId': 'job_test_123', 'status': 'queued', 'printerId': self.printer.gateway_printer_id}
        mock_post.return_value = mock_resp
        
        job = self.branch.create_print_job(
            self.dest_pos.id,
            'order',
            {'type': 'raw', 'encoding': 'base64', 'data': base64.b64encode(b'test').decode()},
            odoo_model='sale.order',
            odoo_record_id=42,
            report_xml_id='sale.action_report_saleorder',
            report_name='sale.report_saleorder',
        )
        self.assertEqual(job.gateway_job_id, 'job_test_123')
        self.assertEqual(job.odoo_model, 'sale.order')
        self.assertEqual(job.odoo_record_id, 42)
        self.assertEqual(job.report_xml_id, 'sale.action_report_saleorder')
        self.assertEqual(job.status, 'queued')

    @patch('odoo.addons.print_gateway.models.print_job.requests.get')
    def test_gateway_job_status_sync(self, mock_get):
        """H. Gateway job status → Odoo Print Job updated"""
        job = self.env['print_gateway.print_job'].create({
            'gateway_job_id': 'job_sync_test',
            'branch_id': self.branch.id,
            'status': 'queued',
        })
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {'status': 'success', 'error': None}
        mock_get.return_value = mock_resp
        
        job.action_sync_status()
        self.assertEqual(job.status, 'success')

    def test_multiple_branches(self):
        """I. Multiple branches"""
        branch2 = self.env['print_gateway.branch'].create({
            'name': 'Branch 2',
            'gateway_url': 'https://gateway2.example.com',
            'gateway_api_key': 'key2',
        })
        dest2 = self.env['print_gateway.destination'].create({
            'name': 'POS 2',
            'branch_id': branch2.id,
            'destination_type': 'pos',
        })
        self.assertNotEqual(self.branch.id, branch2.id)
        self.assertEqual(dest2.branch_id.id, branch2.id)
        # Ensure printer binding respects branch
        with self.assertRaises(Exception):
            # Try to create cross-branch binding (should fail via constraint)
            self.env['print_gateway.printer_binding'].create({
                'branch_id': self.branch.id,
                'destination_id': dest2.id,  # dest2 belongs to branch2, not branch
                'printer_id': self.printer.id,
            })

    def test_multiple_document_types(self):
        """J. Multiple document types"""
        # Create invoice binding
        binding2 = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch.id,
            'destination_id': self.dest_pos.id,
            'document_type_id': self.doc_invoice.id,
            'printer_id': self.printer.id,
            'priority': 2,
        })
        self.assertEqual(binding2.document_type_id.id, self.doc_invoice.id)
        # Check that order and invoice can have different bindings
        self.assertNotEqual(self.binding.document_type_id.id, binding2.document_type_id.id)

    def test_no_hardcoded_printer_id(self):
        """K. No physical printer ID hardcoded in Odoo models"""
        # Check that no model files contain hardcoded printer IDs
        import pathlib
        models_dir = pathlib.Path(__file__).parent.parent / 'models'
        for model_file in models_dir.glob('*.py'):
            content = model_file.read_text()
            # Should not contain printer_xxx hardcoded
            self.assertNotIn('printer_receipt', content, f"Hardcoded printer in {model_file.name}")
            self.assertNotIn('printer_test', content, f"Hardcoded printer in {model_file.name}")
            # Should use branch.create_print_job with destination, not printerId (if it prints)
            if 'create_print_job' in content:
                self.assertIn('destination', content, f"Missing destination in {model_file.name}")

    @patch('odoo.addons.print_gateway.models.ir_actions_report.IrActionsReport._render_qweb_pdf')
    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_actual_pdf_payload_sent(self, mock_post, mock_render):
        """L. Actual PDF/report payload is sent, not just metadata"""
        mock_render.return_value = (b'%PDF-1.4 fake pdf content for testing', 'pdf')
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {'jobId': 'job_pdf_test', 'status': 'queued', 'printerId': self.printer.gateway_printer_id}
        mock_post.return_value = mock_resp

        report = self.env.ref('sale.action_report_saleorder', raise_if_not_found=False)
        if not report:
            self.skipTest("sale report not found")
        report.write({'print_gateway_enabled': True, 'print_gateway_document_type_id': self.doc_order.id})
        
        partner = self.env['res.partner'].create({'name': 'Test Partner PDF'})
        try:
            order = self.env['sale.order'].create({'partner_id': partner.id})
        except Exception:
            self.skipTest("Cannot create sale order")
        
        # Call report_action which should trigger gateway
        # Mock the branch determination to use our test branch/dest
        with patch.object(type(report), '_determine_branch', return_value=self.branch):
            with patch.object(type(report), '_determine_destination', return_value=self.dest_pos):
                with patch.object(type(report), '_determine_document_type', return_value='order'):
                    try:
                        report.report_action(order.id)
                    except Exception as e:
                        # It will return a client action, not raise, but we check mock_post was called
                        pass
        
        # Verify that requests.post was called with actual payload
        self.assertTrue(mock_post.called)
        call_args = mock_post.call_args
        self.assertIsNotNone(call_args)
        # Check payload contains base64 data, not just metadata
        if call_args:
            json_data = call_args[1].get('json', {})
            payload = json_data.get('payload', {})
            self.assertIn('data', payload)
            self.assertIn('type', payload)
            # Decode and check it's actually PDF
            decoded = base64.b64decode(payload['data'])
            self.assertTrue(decoded.startswith(b'%PDF'))
        
        report.write({'print_gateway_enabled': False})
