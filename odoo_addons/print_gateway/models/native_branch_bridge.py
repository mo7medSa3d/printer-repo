# -*- coding: utf-8 -*-
"""Bridge Print Gateway configuration to Odoo's native company/branch records.

Odoo 19 represents branches in the ``res.company`` hierarchy. The Print
Gateway module never creates an Odoo branch. Its legacy ``print_gateway.branch``
model is retained only as a one-to-one configuration mirror of an existing
``res.company`` record so the current destination/agent/printer/routing models
remain stable while the ownership model is migrated.
"""

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayNativeBranchBridge(models.Model):
    _inherit = 'print_gateway.branch'

    company_id = fields.Many2one(
        'res.company',
        string='Odoo Company / Branch',
        required=True,
        readonly=True,
        ondelete='restrict',
        help='Existing Odoo company/branch represented by this Print Gateway configuration.',
    )
    name = fields.Char(
        string='Branch Name',
        readonly=True,
        help='Inherited from the linked Odoo company/branch. Rename it in Odoo.',
    )
    gateway_branch_id = fields.Char(
        string='Gateway Branch ID',
        readonly=True,
        copy=False,
        help='Stable Gateway identity derived from the Odoo company/branch id.',
    )
    gateway_url = fields.Char(
        required=False,
        default='',
        help='Gateway base URL for this Odoo company/branch.',
    )

    @api.model
    def _native_gateway_branch_id(self, company):
        return 'odoo_company_%s' % company.id

    @api.model
    def _native_discovery_values(self, company):
        return {
            'company_id': company.id,
            'name': company.name,
            'gateway_branch_id': self._native_gateway_branch_id(company),
            # Discovery only creates configuration mirrors. Do not activate a
            # scope merely because it exists in Odoo; an administrator must
            # explicitly enable printing after configuring the Gateway.
            'enabled': False,
        }

    @api.model
    def _sync_native_companies(self, companies=None):
        """Discover existing Odoo company/branch records.

        Only Print Gateway configuration mirrors are created here. The method
        never creates or modifies the underlying ``res.company`` records.
        """
        Company = self.env['res.company'].sudo()
        Branch = self.sudo()
        if companies is None:
            companies = Company.search([])
        else:
            companies = companies.sudo()

        created = 0
        updated = 0
        for company in companies:
            values = self._native_discovery_values(company)
            existing = Branch.search([('company_id', '=', company.id)], limit=1)
            if existing:
                existing.with_context(_print_gateway_native_sync=True).write({
                    'name': values['name'],
                    'gateway_branch_id': values['gateway_branch_id'],
                })
                updated += 1
                continue

            Branch.with_context(_print_gateway_native_sync=True).create(values)
            created += 1

        return created, updated

    @api.model
    def action_refresh_from_odoo(self):
        """Refresh Print Gateway mirrors from Odoo's existing companies/branches."""
        if not self.env.user.has_group('base.group_system'):
            raise AccessError(_('Only Odoo system administrators can refresh Print Gateway branches.'))

        created, updated = self._sync_native_companies()
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Odoo Branches Refreshed'),
                'message': _('%s configuration mirrors created, %s refreshed. No Odoo branches were created.') % (created, updated),
                'type': 'success',
                'sticky': False,
            },
        }

    @api.model_create_multi
    def create(self, vals_list):
        """Create only a configuration mirror for an existing Odoo company/branch.

        This method is incapable of creating the business branch because the
        only authoritative identity is the existing ``res.company`` id.
        Existing explicit configuration values are preserved; identity fields
        are always derived from the native Odoo record.
        """
        Company = self.env['res.company'].sudo()
        normalized = []
        for incoming in vals_list:
            vals = dict(incoming)
            company_id = vals.get('company_id') or self.env.company.id
            company = Company.browse(company_id).exists()
            if not company:
                raise ValidationError(_('The selected Odoo company/branch does not exist.'))
            company.ensure_one()
            vals.update({
                'company_id': company.id,
                'name': company.name,
                'gateway_branch_id': self._native_gateway_branch_id(company),
            })
            if 'enabled' not in vals:
                vals['enabled'] = False
            normalized.append(vals)
        return super().create(normalized)

    @api.constrains('company_id')
    def _check_one_configuration_per_company(self):
        for rec in self:
            if not rec.company_id:
                raise ValidationError(_('Every Print Gateway configuration must reference an existing Odoo company/branch.'))
            duplicate = self.search([
                ('company_id', '=', rec.company_id.id),
                ('id', '!=', rec.id),
            ], limit=1)
            if duplicate:
                raise ValidationError(_(
                    'Odoo company/branch %s already has a Print Gateway configuration.'
                ) % rec.company_id.display_name)

    def write(self, vals):
        protected = {'company_id', 'gateway_branch_id'}
        if not self.env.context.get('_print_gateway_native_sync'):
            illegal = protected.intersection(vals)
            if 'name' in vals:
                illegal.add('name')
            if illegal:
                raise AccessError(_(
                    'Branch identity is owned by Odoo. Change the company/branch in Odoo, not in Print Gateway.'
                ))
        return super().write(vals)


class PrintGatewayResCompanyBridge(models.Model):
    _inherit = 'res.company'

    def write(self, vals):
        result = super().write(vals)
        if 'name' in vals:
            configs = self.env['print_gateway.branch'].sudo().search([('company_id', 'in', self.ids)])
            for company in self:
                configs.filtered(lambda c: c.company_id.id == company.id).with_context(
                    _print_gateway_native_sync=True
                ).write({
                    'name': company.name,
                    'gateway_branch_id': 'odoo_company_%s' % company.id,
                })
        return result
