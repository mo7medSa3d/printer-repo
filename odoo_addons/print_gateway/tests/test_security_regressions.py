"""Security regression tests for the print_gateway addon."""

from unittest.mock import MagicMock, patch

from odoo.exceptions import AccessError, ValidationError
from odoo.tests.common import TransactionCase


class PrintGatewaySecurityCase(TransactionCase):
    def _branch(self, company, name='Branch'):
        return self.env['print_gateway.branch'].with_company(company).create({
            'name': name,
            'company_id': company.id,
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'test-key',
            'enabled': True,
        })

    def _destination(self, branch, name='POS'):
        return self.env['print_gateway.destination'].with_company(branch.company_id).create({
            'name': name,
            'branch_id': branch.id,
            'destination_type': 'pos',
            'enabled': True,
        })

    def _user(self, company, login):
        return self.env['res.users'].create({
            'login': login,
            'name': login,
            'company_ids': [(6, 0, [company.id])],
            'company_id': company.id,
        })


class TestPrintGatewaySecurityCompanyIsolation(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company_a = self.env['res.company'].create({'name': 'Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Company B'})
        self.user_a = self._user(self.company_a, 'pg_user_a')
        self.user_b = self._user(self.company_b, 'pg_user_b')
        self.branch_a = self._branch(self.company_a, 'Branch A')
        self.branch_b = self._branch(self.company_b, 'Branch B')
        self.destination_a = self._destination(self.branch_a, 'POS A')
        self.destination_b = self._destination(self.branch_b, 'POS B')

    def test_user_cannot_read_other_company_branches(self):
        branches = self.env['print_gateway.branch'].with_user(self.user_a).search([])
        self.assertIn(self.branch_a, branches)
        self.assertNotIn(self.branch_b, branches)

    def test_user_cannot_write_other_company_destination(self):
        with self.assertRaises(AccessError):
            self.destination_b.with_user(self.user_a).write({'name': 'Hacked'})

    def test_user_cannot_delete_other_company_destination(self):
        with self.assertRaises(AccessError):
            self.destination_b.with_user(self.user_a).unlink()

    def test_user_cannot_create_branch_in_other_company(self):
        with self.assertRaises(AccessError):
            self.env['print_gateway.branch'].with_user(self.user_a).create({
                'name': 'Hacked Branch',
                'company_id': self.company_b.id,
                'gateway_url': 'https://gateway-b.example.com',
                'gateway_api_key': 'bad',
            })

    def test_user_cannot_change_branch_company(self):
        with self.assertRaises(AccessError):
            self.branch_a.with_user(self.user_a).write({'company_id': self.company_b.id})


class TestPrintGatewaySecurityPrinterBindingWrite(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Binding Company'})
        self.user = self._user(self.company, 'pg_binding_user')
        self.system_user = self.env['res.users'].create({
            'login': 'pg_binding_admin',
            'name': 'Binding Admin',
            'company_ids': [(6, 0, [self.company.id])],
            'company_id': self.company.id,
            'group_ids': [(4, self.env.ref('base.group_system').id)],
        })
        self.branch = self._branch(self.company, 'Binding Branch')
        self.destination = self._destination(self.branch, 'Binding POS')
        self.agent = self.env['print_gateway.agent'].with_company(self.company).create({
            'name': 'Binding Agent',
            'gateway_agent_id': 'agt_binding_security',
            'branch_id': self.branch.id,
        })
        self.printer = self.env['print_gateway.printer'].with_company(self.company).create({
            'name': 'Binding Printer',
            'gateway_printer_id': 'printer_binding_security',
            'agent_id': self.agent.id,
        })
        self.binding = self.env['print_gateway.printer_binding'].with_company(self.company).create({
            'branch_id': self.branch.id,
            'destination_id': self.destination.id,
            'printer_id': self.printer.id,
        })

    def test_regular_user_cannot_write_printer_binding(self):
        with self.assertRaises(AccessError):
            self.binding.with_user(self.user).write({'priority': 2})

    def test_regular_user_cannot_create_printer_binding(self):
        with self.assertRaises(AccessError):
            self.env['print_gateway.printer_binding'].with_user(self.user).create({
                'branch_id': self.branch.id,
                'destination_id': self.destination.id,
                'printer_id': self.printer.id,
            })

    def test_system_user_can_write_printer_binding(self):
        self.binding.with_user(self.system_user).write({'priority': 2})
        self.assertEqual(self.binding.priority, 2)

    def test_regular_user_can_read_printer_binding(self):
        binding = self.binding.with_user(self.user)
        self.assertEqual(binding.id, self.binding.id)


class TestPrintGatewaySecurityReportRouting(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company_a = self.env['res.company'].create({'name': 'Report Company A'})
        self.company_b = self.env['res.company'].create({'name': 'Report Company B'})
        self.user_a = self._user(self.company_a, 'pg_report_user_a')
        self.branch_a = self._branch(self.company_a, 'Report Branch A')
        self.branch_b = self._branch(self.company_b, 'Report Branch B')
        self.destination_b = self._destination(self.branch_b, 'Report POS B')

    def test_user_cannot_print_to_other_company_branch(self):
        report = self.env['ir.actions.report'].create({
            'name': 'Test Report',
            'report_name': 'print_gateway.security_report',
            'report_type': 'qweb-pdf',
            'model': 'sale.order',
        })
        self.env['print_gateway.report_mapping'].with_company(self.company_b).create({
            'report_id': report.id,
            'branch_id': self.branch_b.id,
            'destination_id': self.destination_b.id,
            'gateway_enabled': True,
        })
        self.assertFalse(report.with_user(self.user_a)._user_has_branch_access(self.branch_b))


class TestPrintGatewaySecurityAccessControl(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Access Company'})
        self.user = self._user(self.company, 'pg_access_user')
        self.branch = self._branch(self.company, 'Access Branch')

    def test_user_cannot_write_branch(self):
        with self.assertRaises(AccessError):
            self.branch.with_user(self.user).write({'gateway_api_key': 'new-key'})

    def test_user_cannot_create_branch(self):
        with self.assertRaises(AccessError):
            self.env['print_gateway.branch'].with_user(self.user).create({
                'name': 'New Branch',
                'company_id': self.company.id,
                'gateway_url': 'https://example.com',
                'gateway_api_key': 'key',
            })

    def test_user_can_read_branch(self):
        self.assertEqual(self.branch.with_user(self.user).name, self.company.name)


class TestPrintGatewayLifecycleOwnership(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Lifecycle Company'})
        self.branch = self._branch(self.company, 'Lifecycle Branch')
        self.agent = self.env['print_gateway.agent'].with_company(self.company).create({
            'name': 'Lifecycle Agent',
            'gateway_agent_id': 'agt_lifecycle_security',
            'branch_id': self.branch.id,
        })
        self.printer = self.env['print_gateway.printer'].with_company(self.company).create({
            'name': 'Lifecycle Printer',
            'gateway_printer_id': 'printer_lifecycle_security',
            'agent_id': self.agent.id,
        })

    def test_printer_branch_is_derived_and_immutable(self):
        self.assertEqual(self.printer.branch_id, self.agent.branch_id)
        other_company = self.env['res.company'].create({'name': 'Other Lifecycle Company'})
        other_branch = self._branch(other_company, 'Other Lifecycle Branch')
        other_agent = self.env['print_gateway.agent'].with_company(other_company).create({
            'name': 'Other Lifecycle Agent',
            'gateway_agent_id': 'agt_other_lifecycle_security',
            'branch_id': other_branch.id,
        })
        with self.assertRaises(ValidationError):
            self.printer.write({'agent_id': other_agent.id})

    def test_agent_delete_is_blocked(self):
        with self.assertRaises(ValidationError):
            self.agent.unlink()

    def test_printer_delete_is_blocked(self):
        with self.assertRaises(ValidationError):
            self.printer.unlink()

    def test_cross_branch_binding_is_blocked(self):
        other_company = self.env['res.company'].create({'name': 'Binding Other Company'})
        other_branch = self._branch(other_company, 'Binding Other Branch')
        other_destination = self._destination(other_branch, 'Binding Other POS')
        with self.assertRaises(ValidationError):
            self.env['print_gateway.printer_binding'].create({
                'branch_id': other_branch.id,
                'destination_id': other_destination.id,
                'printer_id': self.printer.id,
            })


class TestGatewayPullSyncStatus(PrintGatewaySecurityCase):
    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Pull Sync Company'})
        self.branch = self._branch(self.company, 'Pull Sync Branch')

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_http_500_is_failed(self, mock_get):
        mock_get.return_value = MagicMock(status_code=500, text='boom')
        result = self.branch.action_sync_from_gateway()
        self.assertEqual(result['tag'], 'display_notification')
        self.assertEqual(self.branch.last_sync_status, 'failed')
        self.assertIn('500', self.branch.last_sync_error)

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_timeout_is_failed(self, mock_get):
        import requests
        mock_get.side_effect = requests.Timeout('timed out')
        result = self.branch.action_sync_from_gateway()
        self.assertEqual(result['tag'], 'display_notification')
        self.assertEqual(self.branch.last_sync_status, 'failed')
        self.assertIn('timed out', self.branch.last_sync_error)

    @patch('odoo.addons.print_gateway.models.branch.requests.get')
    def test_malformed_agents_response_is_failed(self, mock_get):
        response = MagicMock(status_code=200)
        response.json.return_value = {'unexpected': 'shape'}
        mock_get.return_value = response
        result = self.branch.action_sync_from_gateway()
        self.assertEqual(result['tag'], 'display_notification')
        self.assertEqual(self.branch.last_sync_status, 'failed')
        self.assertIn('Agents endpoint must return an array', self.branch.last_sync_error)


class TestGatewayApiKeyReadProtection(PrintGatewaySecurityCase):
    """The Gateway credential must be protected by Odoo's field security."""

    def setUp(self):
        super().setUp()
        self.company = self.env['res.company'].create({'name': 'Key Protection Co'})
        self.user = self._user(self.company, 'pg_key_user')
        self.admin = self.env['res.users'].create({
            'login': 'pg_key_admin',
            'name': 'Key Admin',
            'company_ids': [(6, 0, [self.company.id])],
            'company_id': self.company.id,
            'group_ids': [(4, self.env.ref('base.group_system').id)],
        })
        self.branch = self._branch(self.company, 'Key Branch')

    def test_regular_user_cannot_read_key_via_rpc(self):
        with self.assertRaises(AccessError):
            self.branch.with_user(self.user).read(['gateway_api_key'])

    def test_regular_user_cannot_retrieve_key_via_search_read(self):
        with self.assertRaises(AccessError):
            self.env['print_gateway.branch'].with_user(self.user).search_read(
                [('id', '=', self.branch.id)],
                ['gateway_api_key'],
            )

    def test_regular_user_can_read_non_secret_fields(self):
        values = self.branch.with_user(self.user).read(['name', 'gateway_url'])
        self.assertEqual(values[0]['name'], self.company.name)
        self.assertEqual(values[0]['gateway_url'], 'https://gateway.example.com')

    def test_key_field_hidden_from_regular_user_fields_get(self):
        field_names = self.branch.with_user(self.user).fields_get().keys()
        self.assertNotIn('gateway_api_key', field_names)

    def test_system_admin_can_read_key(self):
        values = self.branch.with_user(self.admin).read(['gateway_api_key'])
        self.assertEqual(values[0]['gateway_api_key'], 'test-key')

    def test_system_admin_can_manage_key(self):
        self.branch.with_user(self.admin).write({'gateway_api_key': 'rotated-key'})
        values = self.branch.with_user(self.admin).read(['gateway_api_key'])
        self.assertEqual(values[0]['gateway_api_key'], 'rotated-key')

    def test_sync_actions_require_admin(self):
        for action in ('action_test_connection', 'action_sync_from_gateway', 'action_sync_to_gateway'):
            with self.assertRaises(AccessError):
                getattr(self.branch.with_user(self.user), action)()
