# -*- coding: utf-8 -*-
"""Bridge Print Gateway configuration to Odoo's native company/branch records.

Odoo 19 represents branches in the ``res.company`` hierarchy.  This module
must never create a second business Branch model.  ``print_gateway.branch`` is
kept only as a configuration/runtime mirror so the existing Gateway routing
models can remain stable during migration.
"""

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayNativeBranchBridge(models.Model):
    _inherit = 'print_gateway.branch'

    # These fields identify an existing Odoo company/branch. They are not a
    # second branch identity and therefore cannot be edited from Print Gateway.
    company_id = fields.Many2one(
        'res.company',
        string='Odoo Company / Branch',
        required=True,
        readonly=True,
        ondelete='restrict',
        help='Existing Odoo company/branch that owns this Print Gateway configuration.',
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
            'enabled': bool(getattr(company, 'active', True)),
        }

    @api.model
    def _sync_native_companies(self, companies=None):
        """Discover existing Odoo company/branch records without creating them.

        The records created here are Print Gateway configuration mirrors only;
        the underlying ``res.company`` records are never created or modified.
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
                # Keep administrative Gateway fields untouched; only refresh
                # identity copied from the native Odoo record.
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
        """Expose native Odoo company/branch discovery to system administrators."""
        if not self.env.user.has_group('base.group_system'):
            raise AccessError(_('Only Odoo system administrators can refresh Print Gateway branches.'))

        created, updated = self._sync_native_companies()
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Odoo Branches Refreshed'),
                'message': _('%s configuration records created, %s refreshed. Odoo remains the source of truth for branches.') % (created, updated),
                'type': 'success',
                'sticky': False,
            },
        }

    @api.model_create_multi
    def create(self, vals_list):
        """Reject user-created Print Gateway branches.

        A configuration mirror can only be created by the discovery routine,
        and only for an already-existing ``res.company`` record.
        """
        if not self.env.context.get('_print_gateway_native_sync'):
            raise AccessError(_(
                'Print Gateway does not create branches. Create the company/branch in Odoo first, '
                'then refresh Print Gateway to discover it.'
            ))

        Company = self.env['res.company'].sudo()
        normalized = []
        for incoming in vals_list:
            vals = dict(incoming)
            company_id = vals.get('company_id')
            if not company_id:
                raise ValidationError(_('An existing Odoo company/branch is required.'))
            company = Company.browse(company_id).exists()
            if not company:
                raise ValidationError(_('The selected Odoo company/branch does not exist.'))
            company.ensure_one()
            vals.update(self._native_discovery_values(company))
            normalized.append(vals)
        return super().create(normalized)

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
