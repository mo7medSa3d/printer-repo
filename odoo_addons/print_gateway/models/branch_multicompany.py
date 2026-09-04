# -*- coding: utf-8 -*-
"""Allow managers to create branches in any company they can access.

The base branch model validates creation against ``env.company``. Odoo's
multi-company UI can legitimately create a record for another company the
manager is allowed to operate in, so this adapter switches the environment
company before delegating to the original single-value create override.
"""

from odoo import api, models, _
from odoo.exceptions import AccessError


class PrintGatewayBranchMultiCompany(models.Model):
    _inherit = 'print_gateway.branch'

    @api.model_create_multi
    def create(self, vals_list):
        records = self.env['print_gateway.branch']
        for vals in vals_list:
            company_id = vals.get('company_id') or self.env.company.id
            if company_id not in self.env.user.company_ids.ids:
                raise AccessError(_("You cannot create branches outside your allowed companies."))
            company = self.env['res.company'].browse(company_id).exists()
            if not company:
                raise AccessError(_("The selected branch company does not exist or is inaccessible."))
            record = super(PrintGatewayBranchMultiCompany, self.with_company(company)).create(vals)
            records |= record
        return records
