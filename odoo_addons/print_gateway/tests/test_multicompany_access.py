from odoo import Command
from odoo.exceptions import AccessError
from odoo.tests.common import TransactionCase


class TestPrintGatewayMultiCompanyAccess(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company_a = self.env['res.company'].create({'name': 'Multi A'})
        self.company_b = self.env['res.company'].create({'name': 'Multi B'})
        self.branch_a = self.env['print_gateway.branch'].with_company(self.company_a).create({
            'name': 'Branch A',
            'company_id': self.company_a.id,
            'gateway_url': 'https://gateway-a.example.com',
            'gateway_api_key': 'key-a',
        })
        self.branch_b = self.env['print_gateway.branch'].with_company(self.company_b).create({
            'name': 'Branch B',
            'company_id': self.company_b.id,
            'gateway_url': 'https://gateway-b.example.com',
            'gateway_api_key': 'key-b',
        })
        self.multi_user = self.env['res.users'].create({
            'name': 'Multi Company User',
            'login': 'pg_multicompany_user',
            'company_ids': [Command.set([self.company_a.id, self.company_b.id])],
            'company_id': self.company_a.id,
        })
        self.single_user = self.env['res.users'].create({
            'name': 'Single Company User',
            'login': 'pg_single_company_user',
            'company_ids': [Command.set([self.company_a.id])],
            'company_id': self.company_a.id,
        })

    def test_multi_company_user_can_read_all_accessible_gateway_branches(self):
        branches = self.env['print_gateway.branch'].with_user(self.multi_user).search([])
        self.assertIn(self.branch_a, branches)
        self.assertIn(self.branch_b, branches)

    def test_selected_company_does_not_remove_other_accessible_company_from_read_policy(self):
        user = self.multi_user.with_company(self.company_a)
        branches = self.env['print_gateway.branch'].with_user(user).search([])
        self.assertEqual(set(branches.ids), {self.branch_a.id, self.branch_b.id})

    def test_single_company_user_cannot_read_other_company_branch(self):
        branches = self.env['print_gateway.branch'].with_user(self.single_user).search([])
        self.assertIn(self.branch_a, branches)
        self.assertNotIn(self.branch_b, branches)

    def test_single_company_user_cannot_write_other_company_branch_even_with_record_reference(self):
        with self.assertRaises(AccessError):
            self.branch_b.with_user(self.single_user).write({'name': 'Cross Company Mutation'})
