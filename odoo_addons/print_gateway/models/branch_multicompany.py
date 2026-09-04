# -*- coding: utf-8 -*-
"""Allow managers to create branches in any company they can access."""

from odoo import api, models, _
from odoo.exceptions import AccessError


class PrintGatewayBranchMultiCompany(models.Model):
    _inherit = 'print_gateway.branch'

    @api.model_create_multi
    def create(self, vals_list):
        created_ids = []
        for vals in vals_list:
            company_id = vals.get('company_id') or self.env.company.id
            if company_id not in self.env.user.company_ids.ids:
                raise AccessError(_("You cannot create branches outside your allowed companies."))
            company = self.env['res.company'].browse(company_id).exists()
            if not company:
                raise AccessError(_("The selected branch company does not exist or is inaccessible."))
            record = super(PrintGatewayBranchMultiCompany, self.with_company(company)).create(vals)
            created_ids.extend(record.ids)
        return self.browse(created_ids)
