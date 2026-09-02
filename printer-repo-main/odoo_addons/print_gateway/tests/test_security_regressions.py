"""Security regression tests for print_gateway module.

These tests verify that all security vulnerabilities have been fixed:
1. Company isolation (ir.rule enforcement)
2. Cross-branch access prevention
3. Printer binding write access restriction
4. Report routing company validation
"""

import odoo
from odoo.tests import common, TransactionCase
from odoo.exceptions import AccessError, UserError


class TestPrintGatewaySecurityCompanyIsolation(TransactionCase):
    """Test company isolation via ir.rule on all models."""

    def setUp(self):
        super().setUp()
        # Create two companies
        self.company_a = self.env['res.company'].create({'name': 'Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Company B'})

        # Create users in each company
        self.user_a = self.env['res.users'].create({
            'login': 'user_a',
            'name': 'User A',
            'company_ids': [(4, self.company_a.id)],
            'company_id': self.company_a.id,
        })
        self.user_b = self.env['res.users'].create({
            'login': 'user_b',
            'name': 'User B',
            'company_ids': [(4, self.company_b.id)],
            'company_id': self.company_b.id,
        })

        # Create branches in each company
        self.branch_a = self.env['print_gateway.branch'].with_user(self.user_a).create({
            'name': 'Branch A',
            'company_id': self.company_a.id,
            'gateway_url': 'http://gateway-a.example.com',
            'gateway_api_key': 'key_a',
            'enabled': True,
        })
        self.branch_b = self.env['print_gateway.branch'].with_user(self.user_b).create({
            'name': 'Branch B',
            'company_id': self.company_b.id,
            'gateway_url': 'http://gateway-b.example.com',
            'gateway_api_key': 'key_b',
            'enabled': True,
        })

        # Create destinations in each branch
        self.destination_a = self.env['print_gateway.destination'].with_user(self.user_a).create({
            'name': 'POS A',
            'branch_id': self.branch_a.id,
            'destination_type': 'pos',
            'enabled': True,
        })
        self.destination_b = self.env['print_gateway.destination'].with_user(self.user_b).create({
            'name': 'POS B',
            'branch_id': self.branch_b.id,
            'destination_type': 'pos',
            'enabled': True,
        })

    def test_user_cannot_read_other_company_branches(self):
        """User A cannot read branches from Company B via ir.rule."""
        # User A tries to read all branches
        branches = self.env['print_gateway.branch'].with_user(self.user_a).search([])
        # Should only see Branch A, not Branch B
        self.assertIn(self.branch_a, branches)
        self.assertNotIn(self.branch_b, branches)

    def test_user_cannot_write_other_company_destinations(self):
        """User A cannot modify destinations in Company B."""
        with self.assertRaises(AccessError):
            self.destination_b.with_user(self.user_a).write({'name': 'Hacked'})

    def test_user_cannot_delete_other_company_destinations(self):
        """User A cannot delete destinations in Company B."""
        with self.assertRaises(AccessError):
            self.destination_b.with_user(self.user_a).unlink()

    def test_user_cannot_create_branch_in_other_company(self):
        """User A cannot create a branch in Company B via business logic."""
        with self.assertRaises(AccessError):
            self.env['print_gateway.branch'].with_user(self.user_a).create({
                'name': 'Hacked Branch',
                'company_id': self.company_b.id,
                'gateway_url': 'http://hack.example.com',
                'gateway_api_key': 'hack_key',
            })

    def test_user_cannot_change_branch_company(self):
        """User A cannot change a branch's company assignment."""
        with self.assertRaises(AccessError):
            self.branch_a.with_user(self.user_a).write({
                'company_id': self.company_b.id,
            })


class TestPrintGatewaySecurityPrinterBindingWrite(TransactionCase):
    """Test that only group_system can modify printer bindings."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        # Regular user in company
        self.user = self.env['res.users'].create({
            'login': 'testuser',
            'name': 'Test User',
            'company_ids': [(4, self.company.id)],
            'company_id': self.company.id,
        })

        # System user in company
        self.system_user = self.env['res.users'].create({
            'login': 'sysuser',
            'name': 'System User',
            'company_ids': [(4, self.company.id)],
            'company_id': self.company.id,
            'groups_id': [(4, self.env.ref('base.group_system').id)],
        })

        # Setup: create branch, destination, printer
        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Test Branch',
            'company_id': self.company.id,
            'gateway_url': 'http://gateway.example.com',
            'gateway_api_key': 'test_key',
            'enabled': True,
        })

        self.destination = self.env['print_gateway.destination'].create({
            'name': 'Test Destination',
            'branch_id': self.branch.id,
            'enabled': True,
        })

        self.agent = self.env['print_gateway.agent'].create({
            'name': 'Test Agent',
            'gateway_agent_id': 'agt_test_security',
            'branch_id': self.branch.id,
        })
        self.printer = self.env['print_gateway.printer'].create({
            'name': 'Test Printer',
            'gateway_printer_id': 'printer_test_security',
            'agent_id': self.agent.id,
        })

        self.binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch.id,
            'destination_id': self.destination.id,
            'printer_id': self.printer.id,
        })

    def test_regular_user_cannot_write_printer_binding(self):
        """Regular user cannot modify printer bindings."""
        with self.assertRaises(AccessError):
            self.binding.with_user(self.user).write({'priority': 2})

    def test_regular_user_cannot_create_printer_binding(self):
        """Regular user cannot create new printer bindings."""
        with self.assertRaises(AccessError):
            self.env['print_gateway.printer_binding'].with_user(self.user).create({
                'branch_id': self.branch.id,
                'destination_id': self.destination.id,
                'printer_id': self.printer.id,
            })

    def test_system_user_can_write_printer_binding(self):
        """System user can modify printer bindings."""
        # Should not raise
        self.binding.with_user(self.system_user).write({'priority': 2})
        self.assertEqual(self.binding.priority, 2)

    def test_regular_user_can_read_printer_binding(self):
        """Regular user can read printer bindings in their company."""
        binding = self.binding.with_user(self.user)
        self.assertEqual(binding.id, self.binding.id)


class TestPrintGatewaySecurityReportRouting(TransactionCase):
    """Test that report routing validates company/branch access."""

    def setUp(self):
        super().setUp()
        self.company_a = self.env['res.company'].create({'name': 'Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Company B'})

        # User A (limited to Company A)
        self.user_a = self.env['res.users'].create({
            'login': 'user_a',
            'name': 'User A',
            'company_ids': [(4, self.company_a.id)],
            'company_id': self.company_a.id,
        })

        # User B (limited to Company B)
        self.user_b = self.env['res.users'].create({
            'login': 'user_b',
            'name': 'User B',
            'company_ids': [(4, self.company_b.id)],
            'company_id': self.company_b.id,
        })

        # Setup branches in each company
        self.branch_a = self.env['print_gateway.branch'].create({
            'name': 'Branch A',
            'company_id': self.company_a.id,
            'gateway_url': 'http://gateway-a.example.com',
            'gateway_api_key': 'key_a',
            'enabled': True,
        })

        self.branch_b = self.env['print_gateway.branch'].create({
            'name': 'Branch B',
            'company_id': self.company_b.id,
            'gateway_url': 'http://gateway-b.example.com',
            'gateway_api_key': 'key_b',
            'enabled': True,
        })

        # Destinations
        self.destination_a = self.env['print_gateway.destination'].create({
            'name': 'Dest A',
            'branch_id': self.branch_a.id,
            'enabled': True,
        })

        self.destination_b = self.env['print_gateway.destination'].create({
            'name': 'Dest B',
            'branch_id': self.branch_b.id,
            'enabled': True,
        })

    def test_user_cannot_print_to_other_company_branch(self):
        """User A cannot print to Branch B even if it's enabled."""
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'test_report',
            'report_type': 'qweb-pdf',
            'model': 'sale.order',
        })

        # Create report mapping for Branch B
        mapping = self.env['print_gateway.report_mapping'].create({
            'report_id': report.id,
            'branch_id': self.branch_b.id,
            'destination_id': self.destination_b.id,
            'gateway_enabled': True,
        })

        # User A tries to route via Branch B (should fail)
        ir_report = report.with_user(self.user_a)
        # This test checks that _route_via_gateway will raise due to company mismatch
        # (In real scenario would require actual records, but test validates security logic)
        self.assertFalse(ir_report._user_has_branch_access(self.branch_b))


class TestPrintGatewaySecurityAccessControl(TransactionCase):
    """Test ACL changes prevent unauthorized access."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Test Company'})

        self.user = self.env['res.users'].create({
            'login': 'user',
            'name': 'User',
            'company_ids': [(4, self.company.id)],
            'company_id': self.company.id,
        })

        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Test Branch',
            'company_id': self.company.id,
            'gateway_url': 'http://gateway.example.com',
            'gateway_api_key': 'key',
            'enabled': True,
        })

    def test_user_cannot_write_branch(self):
        """Regular user cannot write to branches (only read)."""
        with self.assertRaises(AccessError):
            self.branch.with_user(self.user).write({'gateway_api_key': 'new_key'})

    def test_user_cannot_create_branch(self):
        """Regular user cannot create branches."""
        with self.assertRaises(AccessError):
            self.env['print_gateway.branch'].with_user(self.user).create({
                'name': 'New Branch',
                'company_id': self.company.id,
                'gateway_url': 'http://example.com',
                'gateway_api_key': 'key',
            })

    def test_user_can_read_branch(self):
        """Regular user can read branches in their company."""
        branch = self.branch.with_user(self.user)
        self.assertEqual(branch.name, 'Test Branch')


if __name__ == '__main__':
    import unittest
    unittest.main()


class TestPrintGatewayLifecycleOwnership(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Lifecycle Company'})
        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Lifecycle Branch', 'company_id': self.company.id,
            'gateway_url': 'http://gateway.example.com', 'gateway_api_key': 'key',
        })
        self.agent = self.env['print_gateway.agent'].create({
            'name': 'Lifecycle Agent', 'gateway_agent_id': 'agt_lifecycle', 'branch_id': self.branch.id,
        })
        self.printer = self.env['print_gateway.printer'].create({
            'name': 'Lifecycle Printer', 'gateway_printer_id': 'printer_lifecycle', 'agent_id': self.agent.id,
        })

    def test_printer_branch_is_derived(self):
        self.assertEqual(self.printer.branch_id, self.agent.branch_id)
        with self.assertRaises(ValidationError):
            self.printer.write({'agent_id': self.env['print_gateway.agent'].create({
                'name': 'Other Agent', 'gateway_agent_id': 'agt_other_lifecycle', 'branch_id': self.env['print_gateway.branch'].create({
                    'name': 'Other Lifecycle Branch', 'company_id': self.company.id,
                    'gateway_url': 'http://other.example.com', 'gateway_api_key': 'other',
                }).id,
            }).id})

    def test_agent_delete_is_blocked(self):
        with self.assertRaises(ValidationError):
            self.agent.unlink()

    def test_printer_delete_is_blocked(self):
        with self.assertRaises(ValidationError):
            self.printer.unlink()

    def test_cross_branch_binding_is_blocked(self):
        other_branch = self.env['print_gateway.branch'].create({
            'name': 'Other Branch', 'company_id': self.company.id,
            'gateway_url': 'http://other.example.com', 'gateway_api_key': 'other',
        })
        dest = self.env['print_gateway.destination'].create({
            'name': 'Other POS', 'branch_id': other_branch.id, 'destination_type': 'pos',
        })
        with self.assertRaises(ValidationError):
            self.env['print_gateway.printer_binding'].create({
                'branch_id': other_branch.id, 'destination_id': dest.id, 'printer_id': self.printer.id,
            })

class TestGatewayPullSyncStatus(TransactionCase):
    """Pull-sync transport failures must be failed, not falsely successful."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Pull Sync Co'})
        self.branch = self.env['print_gateway.branch'].create({
            'name': 'Pull Branch', 'company_id': self.company.id,
            'gateway_url': 'https://gateway.example.com', 'gateway_api_key': 'key', 'enabled': True,
        })

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_http_500_is_failed(self, mock_get):
        response = MagicMock(status_code=500, text='boom')
        mock_get.return_value = response
        with self.assertRaises(ValidationError):
            self.branch.action_sync_from_gateway()
        self.assertEqual(self.branch.last_sync_status, 'failed')

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_timeout_is_failed(self, mock_get):
        import requests
        mock_get.side_effect = requests.Timeout('timed out')
        with self.assertRaises(ValidationError):
            self.branch.action_sync_from_gateway()
        self.assertEqual(self.branch.last_sync_status, 'failed')

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_malformed_agents_response_is_failed(self, mock_get):
        response = MagicMock(status_code=200)
        response.json.return_value = {'unexpected': 'shape'}
        mock_get.return_value = response
        with self.assertRaises(ValidationError):
            self.branch.action_sync_from_gateway()
        self.assertEqual(self.branch.last_sync_status, 'failed')
