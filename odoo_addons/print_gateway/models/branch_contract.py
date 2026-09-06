# -*- coding: utf-8 -*-
"""Canonical identity contract for Odoo-owned branches."""

from odoo import api, models, _
from odoo.exceptions import ValidationError


class PrintGatewayBranchContract(models.Model):
    _inherit = "print_gateway.branch"

    def _canonical_gateway_branch_id(self):
        self.ensure_one()
        if not self.company_id:
            raise ValidationError(_("A print gateway branch must belong to an Odoo company."))
        return f"odoo_company_{self.company_id.id}"

    @api.model_create_multi
    def create(self, vals_list):
        normalized = []
        for incoming in vals_list:
            vals = dict(incoming)
            company_id = vals.get("company_id") or self.env.company.id
            expected = f"odoo_company_{company_id}"
            supplied = vals.get("gateway_branch_id")
            if supplied and supplied != expected:
                raise ValidationError(
                    _("Gateway Branch ID must be %s for this Odoo company.") % expected
                )
            vals["gateway_branch_id"] = expected
            normalized.append(vals)
        return super().create(normalized)

    def write(self, vals):
        normalized = dict(vals)
        if "company_id" in normalized:
            for rec in self:
                if normalized["company_id"] != rec.company_id.id:
                    raise ValidationError(
                        _("The Odoo company of a print gateway branch cannot be changed.")
                    )
        if "gateway_branch_id" in normalized:
            for rec in self:
                expected = rec._canonical_gateway_branch_id()
                if normalized["gateway_branch_id"] != expected:
                    raise ValidationError(
                        _("Gateway Branch ID must be %s for this Odoo company.") % expected
                    )
        for rec in self:
            normalized["gateway_branch_id"] = rec._canonical_gateway_branch_id()
        return super().write(normalized)
