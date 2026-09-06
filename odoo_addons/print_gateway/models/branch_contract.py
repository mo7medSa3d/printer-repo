# -*- coding: utf-8 -*-
"""Canonical identity contract for Odoo-owned branches."""

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


class PrintGatewayBranchContract(models.Model):
    _inherit = "print_gateway.branch"

    gateway_branch_id = fields.Char(
        string="Gateway Branch ID",
        readonly=True,
        copy=False,
        help="Canonical identity derived from the Odoo company: odoo_company_<company_id>.",
    )

    def _canonical_gateway_branch_id(self):
        self.ensure_one()
        if not self.company_id:
            raise ValidationError(_("A print gateway branch must belong to an Odoo company."))
        return f"odoo_company_{self.company_id.id}"

    def _ensure_canonical_gateway_branch_id(self):
        for rec in self:
            expected = rec._canonical_gateway_branch_id()
            if rec.gateway_branch_id != expected:
                super(PrintGatewayBranchContract, rec).write({"gateway_branch_id": expected})
        return self

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
        if "company_id" in vals:
            for rec in self:
                if vals["company_id"] != rec.company_id.id:
                    raise ValidationError(
                        _("The Odoo company of a print gateway branch cannot be changed.")
                    )
        if "gateway_branch_id" in vals:
            for rec in self:
                expected = rec._canonical_gateway_branch_id()
                if vals["gateway_branch_id"] != expected:
                    raise ValidationError(
                        _("Gateway Branch ID must be %s for this Odoo company.") % expected
                    )
        return super().write(vals)

    def action_sync_to_gateway(self):
        self._ensure_canonical_gateway_branch_id()
        return super().action_sync_to_gateway()

    def action_sync_from_gateway(self):
        self._ensure_canonical_gateway_branch_id()
        return super().action_sync_from_gateway()

    @api.model
    def cron_retry_pending_print_jobs(self):
        self.search([])._ensure_canonical_gateway_branch_id()
        return super().cron_retry_pending_print_jobs()


class PrintGatewayPrintJobBranchContract(models.Model):
    _inherit = "print_gateway.print_job"

    @api.model
    def cron_sync_pending_jobs(self):
        self.search([]).mapped("branch_id")._ensure_canonical_gateway_branch_id()
        return super().cron_sync_pending_jobs()
