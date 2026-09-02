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
        # Create two companies
        self.company_a = self.env['res.company'].create({'name': 'Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Company B'})

        # Create multiple branches in Company A (ambiguous situation)
        self.branch_a1 = self.env['print_gateway.branch'].create({
            'name': 'Branch A1',
            'company_id': self.company_a.id,
            'gateway_url': 'https://gateway-a1.example.com',
            'gateway_api_key': 'key_a1',
            'enabled': True,
        })
        self.branch_a2 = self.env['print_gateway.branch'].create({
            'name': 'Branch A2',
            'company_id': self.company_a.id,
            'gateway_url': 'https://gateway-a2.example.com',
            'gateway_api_key': 'key_a2',
            'enabled': True,
        })

        # Create single branch in Company B (deterministic)
        self.branch_b = self.env['print_gateway.branch'].create({
            'name': 'Branch B',
            'company_id': self.company_b.id,
            'gateway_url': 'https://gateway-b.example.com',
            'gateway_api_key': 'key_b',
            'enabled': True,
        })

        # Create destinations
        self.dest_a1 = self.env['print_gateway.destination'].create({
            'name': 'POS A1',
            'branch_id': self.branch_a1.id,
            'destination_type': 'pos',
            'enabled': True,
        })
        self.dest_b = self.env['print_gateway.destination'].create({
            'name': 'POS B',
            'branch_id': self.branch_b.id,
            'destination_type': 'pos',
            'enabled': True,
        })

        # Create document types
        self.doc_type = self.env['print_gateway.document_type'].create({
            'name': 'invoice',
            'branch_id': self.branch_a1.id,
            'enabled': True,
        })

    def test_missing_branch_raises_validation_error(self):
        """Missing branch configuration should raise ValidationError, not silently fallback."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
            'print_gateway_document_type_id': self.doc_type.id,
        })

        partner = self.env['res.partner'].create({
            'name': 'Test Partner',
            'company_id': self.env.ref('base.main_company').id,  # No branch for this company
        })

        with self.assertRaises(ValidationError) as cm:
            report._determine_branch(partner, {})
        self.assertIn('Unable to determine', str(cm.exception))

    def test_multiple_branches_same_company_raises_validation_error(self):
        """Multiple branches for same company should raise, not arbitrarily select first."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        partner = self.env['res.partner'].create({
            'name': 'Test Partner',
            'company_id': self.company_a.id,  # Has multiple branches
        })

        with self.assertRaises(ValidationError) as cm:
            report._determine_branch(partner, {})
        self.assertIn('Multiple print branches', str(cm.exception))

    def test_unique_branch_per_company_is_deterministic(self):
        """Single branch per company should be selected deterministically."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        partner = self.env['res.partner'].create({
            'name': 'Test Partner',
            'company_id': self.company_b.id,  # Has unique branch
        })

        branch = report._determine_branch(partner, {})
        self.assertEqual(branch.id, self.branch_b.id)

    def test_explicit_branch_mapping_takes_priority(self):
        """Explicit branch in mapping should override record's company."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        partner = self.env['res.partner'].create({
            'name': 'Test Partner',
            'company_id': self.company_b.id,
        })

        mapping_info = {'branch_id': self.branch_a1}
        branch = report._determine_branch(partner, mapping_info)
        self.assertEqual(branch.id, self.branch_a1.id)


class TestMultiRecordRouting(TransactionCase):
    """Test multi-record routing consistency validation."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        # Create branches
        self.branch_1 = self.env['print_gateway.branch'].create({
            'name': 'Branch 1',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway-1.example.com',
            'gateway_api_key': 'key1',
            'enabled': True,
        })
        self.branch_2 = self.env['print_gateway.branch'].create({
            'name': 'Branch 2',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway-2.example.com',
            'gateway_api_key': 'key2',
            'enabled': True,
        })

        # Create destinations
        self.dest_1 = self.env['print_gateway.destination'].create({
            'name': 'POS 1',
            'branch_id': self.branch_1.id,
            'destination_type': 'pos',
            'enabled': True,
        })
        self.dest_2 = self.env['print_gateway.destination'].create({
            'name': 'POS 2',
            'branch_id': self.branch_2.id,
            'destination_type': 'pos',
            'enabled': True,
        })

        # Create document types
        self.doc_type = self.env['print_gateway.document_type'].create({
            'name': 'invoice',
            'branch_id': self.branch_1.id,
            'enabled': True,
        })

    def test_empty_recordset_raises_validation_error(self):
        """Empty recordset should raise ValidationError."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        empty_recordset = self.env['res.partner'].browse([])

        with self.assertRaises(ValidationError) as cm:
            report._validate_recordset_routing_consistency(empty_recordset, {})
        self.assertIn('empty', str(cm.exception).lower())

    def test_single_record_is_always_valid(self):
        """Single record should always pass routing validation."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        partner = self.env['res.partner'].create({
            'name': 'Test Partner',
            'company_id': self.company.id,
        })

        mapping_info = {
            'branch_id': self.branch_1,
            'destination_id': self.dest_1,
        }
        groups = report._validate_recordset_routing_consistency(partner, mapping_info)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['branch'].id, self.branch_1.id)
        self.assertEqual(groups[0]['destination'].id, self.dest_1.id)

    def test_homogeneous_multi_record_passes(self):
        """Multiple records with identical routing should pass."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        mapping_info = {
            'branch_id': self.branch_1,
            'destination_id': self.dest_1,
        }

        partner1 = self.env['res.partner'].create({
            'name': 'Partner 1',
            'company_id': self.company.id,
        })
        partner2 = self.env['res.partner'].create({
            'name': 'Partner 2',
            'company_id': self.company.id,
        })

        partners = partner1 | partner2
        groups = report._validate_recordset_routing_consistency(partners, mapping_info)
        self.assertEqual(len(groups), 1)
        self.assertEqual(len(groups[0]['records']), 2)

    def test_heterogeneous_branch_raises_validation_error(self):
        """Multiple records with different branches should raise ValidationError."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        # Create partners in different companies (different branches)
        company_a = self.env['res.company'].create({'name': 'Company A'})
        company_b = self.env['res.company'].create({'name': 'Company B'})

        branch_a = self.env['print_gateway.branch'].create({
            'name': 'Branch A',
            'company_id': company_a.id,
            'gateway_url': 'https://gateway-a.example.com',
            'gateway_api_key': 'key_a',
            'enabled': True,
        })
        branch_b = self.env['print_gateway.branch'].create({
            'name': 'Branch B',
            'company_id': company_b.id,
            'gateway_url': 'https://gateway-b.example.com',
            'gateway_api_key': 'key_b',
            'enabled': True,
        })

        partner_a = self.env['res.partner'].create({
            'name': 'Partner A',
            'company_id': company_a.id,
        })
        partner_b = self.env['res.partner'].create({
            'name': 'Partner B',
            'company_id': company_b.id,
        })

        partners = partner_a | partner_b

        with self.assertRaises(ValidationError) as cm:
            report._validate_recordset_routing_consistency(partners, {})
        self.assertIn('different print routing', str(cm.exception))


class TestCrossBranchValidation(TransactionCase):
    """Test cross-branch routing prevention."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        # Create two branches
        self.branch_1 = self.env['print_gateway.branch'].create({
            'name': 'Branch 1',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway-1.example.com',
            'gateway_api_key': 'key1',
            'enabled': True,
        })
        self.branch_2 = self.env['print_gateway.branch'].create({
            'name': 'Branch 2',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway-2.example.com',
            'gateway_api_key': 'key2',
            'enabled': True,
        })

        # Create destination in branch 2
        self.dest_2 = self.env['print_gateway.destination'].create({
            'name': 'POS 2',
            'branch_id': self.branch_2.id,
            'destination_type': 'pos',
            'enabled': True,
        })

    def test_destination_from_wrong_branch_raises_error(self):
        """Destination from different branch should raise ValidationError."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        # Try to use destination from branch_2 with branch_1
        with self.assertRaises(ValidationError) as cm:
            report._determine_destination(self.branch_1, None, {
                'destination_id': self.dest_2
            })
        self.assertIn('cross-branch', str(cm.exception).lower())

    def test_missing_destination_raises_error(self):
        """Branch with no destination should raise ValidationError."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'res.partner',
            'print_gateway_enabled': True,
        })

        # branch_1 has no destinations
        with self.assertRaises(ValidationError) as cm:
            report._determine_destination(self.branch_1, None, {})
        self.assertIn('no enabled destinations', str(cm.exception).lower())


class TestIdempotency(TransactionCase):
    """Test idempotency behavior."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Branch',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'key',
            'enabled': True,
        })

        self.dest = self.env['print_gateway.destination'].create({
            'name': 'POS',
            'branch_id': self.branch.id,
            'destination_type': 'pos',
            'enabled': True,
        })

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_retry_with_same_idempotency_key_returns_same_job(self, mock_post):
        """Retry of same logical operation should return existing job."""
        # First call returns new job
        mock_resp_1 = MagicMock()
        mock_resp_1.status_code = 201
        mock_resp_1.json.return_value = {
            'jobId': 'job_123',
            'status': 'queued',
            'printerId': 'printer_1',
        }

        # Second call (retry) returns existing job with 200
        mock_resp_2 = MagicMock()
        mock_resp_2.status_code = 200
        mock_resp_2.json.return_value = {
            'jobId': 'job_123',  # Same job ID
            'status': 'queued',
            'printerId': 'printer_1',
        }

        mock_post.side_effect = [mock_resp_1, mock_resp_2]

        idempotency_key = 'fixed_key_for_test'

        # First submission
        job1 = self.branch.create_print_job(
            self.dest.id,
            'invoice',
            {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            idempotency_key=idempotency_key,
        )

        # Second submission with same idempotency key
        job2 = self.branch.create_print_job(
            self.dest.id,
            'invoice',
            {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            idempotency_key=idempotency_key,
        )

        # Both should reference the same gateway job
        self.assertEqual(job1.gateway_job_id, job2.gateway_job_id)

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_different_idempotency_key_creates_new_job(self, mock_post):
        """Different idempotency key should create new job."""
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        mock_resp.json.return_value = {
            'jobId': 'job_{}'.format(mock_post.call_count),
            'status': 'queued',
            'printerId': 'printer_1',
        }
        mock_post.return_value = mock_resp

        # First submission
        job1 = self.branch.create_print_job(
            self.dest.id,
            'invoice',
            {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            idempotency_key='key_1',
        )

        # Second submission with different idempotency key
        job2 = self.branch.create_print_job(
            self.dest.id,
            'invoice',
            {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            idempotency_key='key_2',
        )

        # Both should have been submitted
        self.assertEqual(mock_post.call_count, 2)


class TestGatewayErrorHandling(TransactionCase):
    """Test Gateway error handling (401, 403, 409, 422, 500)."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Branch',
            'company_id': self.company.id,
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'key',
            'enabled': True,
        })

        self.dest = self.env['print_gateway.destination'].create({
            'name': 'POS',
            'branch_id': self.branch.id,
            'destination_type': 'pos',
            'enabled': True,
        })

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_401_raises_error(self, mock_post):
        """Gateway 401 should raise error."""
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = 'Unauthorized'
        mock_post.return_value = mock_resp

        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(
                self.dest.id,
                'invoice',
                {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            )
        self.assertIn('401', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_409_raises_error(self, mock_post):
        """Gateway 409 (routing/printer failure) should raise error."""
        mock_resp = MagicMock()
        mock_resp.status_code = 409
        mock_resp.text = 'Printer disabled'
        mock_post.return_value = mock_resp

        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(
                self.dest.id,
                'invoice',
                {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            )
        self.assertIn('409', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_500_raises_error(self, mock_post):
        """Gateway 500 should raise error."""
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = 'Internal server error'
        mock_post.return_value = mock_resp

        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(
                self.dest.id,
                'invoice',
                {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            )
        self.assertIn('500', str(cm.exception))

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_gateway_timeout_raises_error(self, mock_post):
        """Gateway timeout should raise error after retry."""
        import requests
        mock_post.side_effect = requests.Timeout('Connection timed out')

        with self.assertRaises(ValidationError) as cm:
            self.branch.create_print_job(
                self.dest.id,
                'invoice',
                {'type': 'pdf', 'encoding': 'base64', 'data': 'test'},
            )
        self.assertIn('timeout', str(cm.exception).lower())


class TestMultiBranchSyncPartialFailure(TransactionCase):
    """Per-branch sync is independent; a middle failure is recorded and retryable."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Sync Co'})
        self.branches = self.env['print_gateway.branch']
        for name in ('Branch A', 'Branch B', 'Branch C'):
            self.branches |= self.env['print_gateway.branch'].create({
                'name': name,
                'company_id': self.company.id,
                'gateway_url': 'https://gateway.example.com',
                'gateway_api_key': 'key-%s' % name,
                'enabled': True,
            })

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_middle_branch_failure_is_recorded_and_others_continue(self, mock_post):
        ok = MagicMock()
        ok.status_code = 200
        ok.text = '{"success": true}'
        fail = MagicMock()
        fail.status_code = 500
        fail.text = 'boom'
        fail.json.side_effect = ValueError('not json')
        mock_post.side_effect = [ok, fail, ok]

        with self.assertRaises(ValidationError) as cm:
            self.branches.action_sync_to_gateway()
        self.assertIn('partially failed', str(cm.exception).lower())

        a, b, c = self.branches
        self.assertEqual(a.last_sync_status, 'success')
        self.assertEqual(b.last_sync_status, 'failed')
        self.assertTrue(b.last_sync_error)
        self.assertEqual(c.last_sync_status, 'success')

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_retry_after_partial_failure_converges(self, mock_post):
        ok = MagicMock()
        ok.status_code = 200
        ok.text = '{"success": true}'
        mock_post.return_value = ok
        self.branches.action_sync_to_gateway()
        for branch in self.branches:
            self.assertEqual(branch.last_sync_status, 'success')
            self.assertFalse(branch.last_sync_error)

    @patch('odoo.addons.print_gateway.models.branch.requests.post')
    def test_duplicate_sync_is_idempotent(self, mock_post):
        ok = MagicMock()
        ok.status_code = 200
        ok.text = '{"success": true}'
        mock_post.return_value = ok
        self.branches.action_sync_to_gateway()
        self.branches.action_sync_to_gateway()
        self.assertEqual(mock_post.call_count, 6)


if __name__ == '__main__':
    import unittest
    unittest.main()
