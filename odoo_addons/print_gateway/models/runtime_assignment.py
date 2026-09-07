# -*- coding: utf-8 -*-
"""Odoo-owned association between a native branch and an opaque Gateway agent."""

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayRuntimeAgentAssignment(models.Model):
    _name = "print_gateway.runtime_agent_assignment"
    _description = "Print Gateway Runtime Agent Assignment"
    _order = "company_id, branch_id"

    company_id = fields.Many2one(
        "res.company",
        string="Odoo Company",
        required=True,
        default=lambda self: self.env.company,
        ondelete="restrict",
        index=True,
    )
    branch_id = fields.Many2one(
        "res.company",
        string="Odoo Branch",
        required=True,
        ondelete="restrict",
        index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    runtime_agent_id = fields.Char(
        string="Gateway Runtime Agent",
        required=True,
        copy=False,
        index=True,
    )
    enabled = fields.Boolean(default=True)
    name = fields.Char(compute="_compute_name", store=True)

    _branch_unique = models.Constraint(
        "UNIQUE(company_id, branch_id)",
        "Only one runtime agent assignment is allowed for an Odoo branch.",
    )

    @api.depends("company_id", "branch_id", "runtime_agent_id")
    def _compute_name(self):
        for record in self:
            record.name = "%s / %s → %s" % (
                record.company_id.display_name if record.company_id else "Company",
                record.branch_id.display_name if record.branch_id else "Branch",
                record.runtime_agent_id or "Agent",
            )

    def _check_admin(self):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can change runtime agent assignments."))

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        records = super().create(vals_list)
        records._check_assignment()
        return records

    def write(self, vals):
        if set(vals).intersection({"company_id", "branch_id", "runtime_agent_id", "enabled"}):
            self._check_admin()
        result = super().write(vals)
        self._check_assignment()
        return result

    @api.constrains("company_id", "branch_id", "runtime_agent_id")
    def _check_assignment(self):
        for record in self:
            if record.company_id not in self.env.companies:
                raise ValidationError(_("The selected Odoo company is not available to the current user."))
            if record.branch_id not in self.env.companies:
                raise ValidationError(_("The selected Odoo branch is not available to the current user."))
            if not record.branch_id.parent_id or record.branch_id.parent_id != record.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))
            if not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip():
                raise ValidationError(_("A non-empty Gateway runtime agent ID is required."))
