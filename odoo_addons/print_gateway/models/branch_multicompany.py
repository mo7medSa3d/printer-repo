# -*- coding: utf-8 -*-
"""Allow managers to create branches in any company they can access.

The base branch model validates creation against ``env.company``. Odoo's
multi-company UI can legitimately create a record for another company the
manager is allowed to operate in, so this adapter switches the environment
company before delegating to the original create implementation.
"""

from odoo import api, models, _
from odoo.exceptions import AccessError


class PrintGatewayBranchMultiCompany(models.Model):
    _inherit = 'print_gateway.branch'

    @api.model_create_multi
    def create(self, vals_list):
        grouped = {}
        for vals in vals_list:
            company_id = vals.get('company_id') or self.env.company.id
            if company_id not in self.env.user.company_ids.ids:
                raise AccessError(_("You cannot create branches outside your allowed companies."))
            grouped.setdefault(company_id, []).append(vals)

        records = self.env['print_gateway.branch']
        for company_id, company_vals in grouped.items():
            company = self.env['res.company'].browse(company_id).exists()
            if not company:
                raise AccessError(_("The selected branch company does not exist or is inaccessible."))
            records |= super(PrintGatewayBranchMultiCompany, self.with_company(company)).create(company_vals)
        return records
