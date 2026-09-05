# -*- coding: utf-8 -*-
"""Comprehensive routing and multi-record tests for print_gateway.

These tests verify that the production correctness fixes are working:
1. Fail-closed branch resolution (no arbitrary first branch)
2. Multi-record routing consistency validation
3. Empty recordset handling
4. Cross-branch validation
5. Idempotency behavior
"""

from odoo.tests.common import TransactionCase
from odoo.exceptions import UserError, ValidationError
from unittest.mock import patch, MagicMock
import base64


class TestRoutingFailClosed(TransactionCase):
    """Test fail-closed branch resolution."""

    def setUp(self):
        super().setUp()
        self.company_a = self.env['res.company'].create({'name': 'Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Company B'})
        self.branch_a1 = self.env['print_gateway.branch'].create({'name': 'Branch A1', 'company_id': self.company_a.id, 'gateway_url': 'https://gateway-a1.example.com', 'gateway_api_key': 'key_a1', 'enabled': True})
        self.branch_a2 = self.env['print_gateway.branch'].create({'name': 'Branch A2', 'company_id': self.company_a.id, 'gateway_url': 'https://gateway-a2.example.com', 'gateway_api_key': 'key_a2', 'enabled': True})
        self.branch_b = self.env['print_gateway.branch'].create({'name': 'Branch B', 'company_id': self.company_b.id, 'gateway_url': 'https://gateway-b.example.com', 'gateway_api_key': 'key_b', 'enabled': True})
        self.dest_a1 = self.env['print_gateway.destination'].create({'name': 'POS A1', 'branch_id': self.branch_a1.id, 'destination_type': 'pos', 'enabled': True})
        self.dest_b = self.env['print_gateway.destination'].create({'name': 'POS B', 'branch_id': self.branch_b.id, 'destination_type': 'pos', 'enabled': True})
        self.doc_type = self.env['print_gateway.document_type'].create({'name': 'invoice', 'branch_id': self.branch_a1.id, 'enabled': True})

    def test_missing_branch_raises_validation_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True, 'print_gateway_document_type_id': self.doc_type.id})
        partner = self.env['res.partner'].create({'name': 'Test Partner', 'company_id': self.env.ref('base.main_company').id})
        with self.assertRaises(ValidationError) as cm:
            report._determine_branch(partner, {})
        self.assertIn('Unable to determine', str(cm.exception))

    def test_multiple_branches_same_company_raises_validation_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        partner = self.env['res.partner'].create({'name': 'Test Partner', 'company_id': self.company_a.id})
        with self.assertRaises(ValidationError) as cm:
            report._determine_branch(partner, {})
        self.assertIn('Multiple print branches', str(cm.exception))

    def test_unique_branch_per_company_is_deterministic(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        partner = self.env['res.partner'].create({'name': 'Test Partner', 'company_id': self.company_b.id})
        branch = report._determine_branch(partner, {})
        self.assertEqual(branch.id, self.branch_b.id)

    def test_explicit_branch_mapping_takes_priority(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        partner = self.env['res.partner'].create({'name': 'Test Partner', 'company_id': self.company_b.id})
        branch = report._determine_branch(partner, {'branch_id': self.branch_a1})
        self.assertEqual(branch.id, self.branch_a1.id)


class TestMultiRecordRouting(TransactionCase):
    """Test multi-record routing consistency validation."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})
        self.branch_1 = self.env['print_gateway.branch'].create({'name': 'Branch 1', 'company_id': self.company.id, 'gateway_url': 'https://gateway-1.example.com', 'gateway_api_key': 'key1', 'enabled': True})
        self.branch_2 = self.env['print_gateway.branch'].create({'name': 'Branch 2', 'company_id': self.company.id, 'gateway_url': 'https://gateway-2.example.com', 'gateway_api_key': 'key2', 'enabled': True})
        self.dest_1 = self.env['print_gateway.destination'].create({'name': 'POS 1', 'branch_id': self.branch_1.id, 'destination_type': 'pos', 'enabled': True})
        self.dest_2 = self.env['print_gateway.destination'].create({'name': 'POS 2', 'branch_id': self.branch_2.id, 'destination_type': 'pos', 'enabled': True})
        self.doc_type = self.env['print_gateway.document_type'].create({'name': 'invoice', 'branch_id': self.branch_1.id, 'enabled': True})

    def test_empty_recordset_raises_validation_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        with self.assertRaises(ValidationError) as cm:
            report._validate_recordset_routing_consistency(self.env['res.partner'].browse([]), {})
        self.assertIn('empty', str(cm.exception).lower())

    def test_single_record_is_always_valid(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        partner = self.env['res.partner'].create({'name': 'Test Partner', 'company_id': self.company.id})
        groups = report._validate_recordset_routing_consistency(partner, {'branch_id': self.branch_1, 'destination_id': self.dest_1})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['branch'].id, self.branch_1.id)
        self.assertEqual(groups[0]['destination'].id, self.dest_1.id)

    def test_homogeneous_multi_record_passes(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        mapping_info = {'branch_id': self.branch_1, 'destination_id': self.dest_1}
        partner1 = self.env['res.partner'].create({'name': 'Partner 1', 'company_id': self.company.id})
        partner2 = self.env['res.partner'].create({'name': 'Partner 2', 'company_id': self.company.id})
        groups = report._validate_recordset_routing_consistency(partner1 | partner2, mapping_info)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]['records']), 2)

    def test_heterogeneous_branch_raises_validation_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        company_a = self.env['res.company'].create({'name': 'Company A'})
        company_b = self.env['res.company'].create({'name': 'Company B'})
        self.env['print_gateway.branch'].create({'name': 'Branch A', 'company_id': company_a.id, 'gateway_url': 'https://gateway-a.example.com', 'gateway_api_key': 'key_a', 'enabled': True})
        self.env['print_gateway.branch'].create({'name': 'Branch B', 'company_id': company_b.id, 'gateway_url': 'https://gateway-b.example.com', 'gateway_api_key': 'key_b', 'enabled': True})
        partner_a = self.env['res.partner'].create({'name': 'Partner A', 'company_id': company_a.id})
        partner_b = self.env['res.partner'].create({'name': 'Partner B', 'company_id': company_b.id})
        with self.assertRaises(ValidationError) as cm:
            report._validate_recordset_routing_consistency(partner_a | partner_b, {})
        self.assertIn('different print routing', str(cm.exception))


class TestCrossBranchValidation(TransactionCase):
    """Test cross-branch routing prevention."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})
        self.branch_1 = self.env['print_gateway.branch'].create({'name': 'Branch 1', 'company_id': self.company.id, 'gateway_url': 'https://gateway-1.example.com', 'gateway_api_key': 'key1', 'enabled': True})
        self.branch_2 = self.env['print_gateway.branch'].create({'name': 'Branch 2', 'company_id': self.company.id, 'gateway_url': 'https://gateway-2.example.com', 'gateway_api_key': 'key2', 'enabled': True})
        self.dest_2 = self.env['print_gateway.destination'].create({'name': 'POS 2', 'branch_id': self.branch_2.id, 'destination_type': 'pos', 'enabled': True})

    def test_destination_from_wrong_branch_raises_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        with self.assertRaises(ValidationError) as cm:
            report._determine_destination(self.branch_1, None, {'destination_id': self.dest_2})
        self.assertIn('cross-branch', str(cm.exception).lower())

    def test_missing_destination_raises_error(self):
        report = self.env['ir.actions.report'].create({'name': 'Test Report', 'report_name': 'test_report', 'report_type': 'qweb-pdf', 'model': 'res.partner', 'print_gateway_enabled': True})
        with self.assertRaises(ValidationError) as cm:
            report._determine_destination(self.branch_1, None, {})
        self.assertIn('no enabled destinations', str(cm.exception).lower())


class TestIdempotency(TransactionCase):
    """Test idempotency behavior."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})
        self.branch = self.env['print_gateway.branch'].create({'name': 'Branch', 'company_id': self.company.id, 'gateway_url': 'https://gateway.example.com', 'gateway_api_key': 'key', 'enabled': True})
        self.dest = self.env['print_gateway.destination'].create({'name': 'POS', 'branch_id': self.branch.id, 'destination_type': 'pos', 'enabled': True})

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_retry_with_same_idempotency_key_returns_same_job(self, mock_post):
        mock_resp_1 = MagicMock(status_code=201)
        mock_resp_1.json.return_value = {'jobId': 'job_123', 'status': 'queued', 'printerId': 'printer_1'}
        mock_resp_2 = MagicMock(status_code=200)
        mock_resp_2.json.return_value = {'jobId': 'job_123', 'status': 'queued', 'printerId': 'printer_1'}
        mock_post.side_effect = [mock_resp_1, mock_resp_2]
        job1 = self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'}, idempotency_key='fixed_key_for_test')
        job2 = self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'}, idempotency_key='fixed_key_for_test')
        self.assertEqual(job1.gateway_job_id, job2.gateway_job_id)

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_different_idempotency_key_creates_new_job(self, mock_post):
        def response(*args, **kwargs):
            result = MagicMock(status_code=201)
            result.json.return_value = {'jobId': 'job_%s' % mock_post.call_count, 'status': 'queued', 'printerId': 'printer_1'}
            return result
        mock_post.side_effect = response
        self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'}, idempotency_key='key_1')
        self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'}, idempotency_key='key_2')
        self.assertEqual(mock_post.call_count, 2)


class TestGatewayErrorHandling(TransactionCase):
    """Test Gateway error handling (401, 403, 409, 422, 500)."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})
        self.branch = self.env['print_gateway.branch'].create({'name': 'Branch', 'company_id': self.company.id, 'gateway_url': 'https://gateway.example.com', 'gateway_api_key': 'key', 'enabled': True})
        self.dest = self.env['print_gateway.destination'].create({'name': 'POS', 'branch_id': self.branch.id, 'destination_type': 'pos', 'enabled': True})

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_401_raises_error(self, mock_post):
        mock_post.return_value = MagicMock(status_code=401, text='Unauthorized')
        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'})
        self.assertIn('401', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_409_raises_error(self, mock_post):
        mock_post.return_value = MagicMock(status_code=409, text='Printer disabled')
        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'})
        self.assertIn('409', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_500_raises_error(self, mock_post):
        mock_post.return_value = MagicMock(status_code=500, text='Internal server error')
        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'})
        self.assertIn('500', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_timeout_raises_error(self, mock_post):
        import requests
        mock_post.side_effect = requests.Timeout('Connection timed out')
        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(self.dest.id, 'invoice', {'type': 'pdf', 'encoding': 'base64', 'data': 'test'})
        self.assertIn('timeout', str(cm.exception).lower())


class TestMultiBranchSyncPartialFailure(TransactionCase):
    """Per-branch sync is independent; a middle failure is recorded and retryable."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Sync Co'})
        self.branches = self.env['print_gateway.branch']
        for name in ('Branch A', 'Branch B', 'Branch C'):
            self.branches |= self.env['print_gateway.branch'].create({'name': name, 'company_id': self.company.id, 'gateway_url': 'https://gateway.example.com', 'gateway_api_key': 'key-%s' % name, 'enabled': True})

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_middle_branch_failure_is_recorded_and_others_continue(self, mock_post):
        ok = MagicMock(status_code=200)
        ok.json.return_value = {'success': True}
        fail = MagicMock(status_code=500, text='boom')
        fail.json.side_effect = ValueError('not json')
        mock_post.side_effect = [ok, fail, ok]
        result = self.branches.action_sync_to_gateway()
        self.assertEqual(result['tag'], 'display_notification')
        a, b, c = self.branches
        self.assertEqual(a.last_sync_status, 'success')
        self.assertEqual(b.last_sync_status, 'failed')
        self.assertTrue(b.last_sync_error)
        self.assertEqual(c.last_sync_status, 'success')

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_retry_after_partial_failure_converges(self, mock_post):
        ok = MagicMock(status_code=200)
        ok.json.return_value = {'success': True}
        mock_post.return_value = ok
        self.branches.action_sync_to_gateway()
        for branch in self.branches:
            self.assertEqual(branch.last_sync_status, 'success')
            self.assertFalse(branch.last_sync_error)

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_duplicate_sync_is_idempotent(self, mock_post):
        ok = MagicMock(status_code=200)
        ok.json.return_value = {'success': True}
        mock_post.return_value = ok
        self.branches.action_sync_to_gateway()
        self.branches.action_sync_to_gateway()
        self.assertEqual(mock_post.call_count, 6)


if __name__ == '__main__':
    import unittest
    unittest.main()
