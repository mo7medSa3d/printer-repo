"""Regression tests for native Odoo company/branch ownership."""

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestNativeBranchOwnership(TransactionCase):
    def test_gateway_config_never_creates_odoo_branch(self):
        Company = self.env['res.company']
        Branch = self.env['print_gateway.branch']

        before_ids = set(Company.search([]).ids)
        config = Branch.create({
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_key',
        })

        after_ids = set(Company.search([]).ids)
        self.assertEqual(before_ids, after_ids)
        self.assertEqual(config.company_id, self.env.company)
        self.assertEqual(config.gateway_branch_id, 'odoo_company_%s' % self.env.company.id)
        self.assertEqual(config.name, self.env.company.name)

    def test_discovery_uses_existing_odoo_companies(self):
        company = self.env['res.company'].create({'name': 'Existing Client Branch'})
        before = self.env['print_gateway.branch'].search_count([
            ('company_id', '=', company.id),
        ])

        created, updated = self.env['print_gateway.branch']._sync_native_companies(company)

        after = self.env['print_gateway.branch'].search_count([
            ('company_id', '=', company.id),
        ])
        self.assertEqual(before, 0)
        self.assertEqual(after, 1)
        self.assertEqual(created, 1)
        self.assertEqual(updated, 0)

        config = self.env['print_gateway.branch'].search([
            ('company_id', '=', company.id),
        ], limit=1)
        self.assertEqual(config.name, company.name)
        self.assertEqual(config.gateway_branch_id, 'odoo_company_%s' % company.id)

    def test_company_rename_updates_gateway_mirror_identity(self):
        config = self.env['print_gateway.branch'].create({
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_key',
        })
        company = config.company_id
        company.write({'name': 'Renamed Existing Branch'})
        config.invalidate_recordset(['name', 'gateway_branch_id'])
        self.assertEqual(config.name, 'Renamed Existing Branch')
        self.assertEqual(config.gateway_branch_id, 'odoo_company_%s' % company.id)

    def test_duplicate_configuration_for_same_odoo_company_is_rejected(self):
        Branch = self.env['print_gateway.branch']
        first = Branch.create({
            'gateway_url': 'https://gateway.example.com',
            'gateway_api_key': 'odoo_test_key',
        })

        with self.assertRaises(ValidationError):
            Branch.create({
                'company_id': first.company_id.id,
                'gateway_url': 'https://gateway.example.com',
                'gateway_api_key': 'odoo_second_key',
            })
