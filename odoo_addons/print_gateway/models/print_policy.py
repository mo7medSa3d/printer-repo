# -*- coding: utf-8 -*-
"""Print Policy engine for event-driven automated print dispatch."""

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError
from odoo.tools.safe_eval import safe_eval


EVENT_TYPES = [
    ("picking_validated", "Stock Picking Validated"),
    ("invoice_posted", "Customer Invoice / Bill Posted"),
    ("pos_order_paid", "Point of Sale Order Paid"),
]


class PrintGatewayPolicy(models.Model):
    _name = "print_gateway.policy"
    _description = "Print Gateway Dispatch Policy"
    _order = "priority asc, id asc"

    name = fields.Char(string="Policy Name", required=True)
    active = fields.Boolean(default=True)
    company_id = fields.Many2one(
        "res.company", string="Odoo Company", required=True,
        default=lambda self: self.env.company, ondelete="restrict", index=True,
        domain="[('parent_id', '=', False)]",
    )
    branch_id = fields.Many2one(
        "res.company", string="Odoo Branch", ondelete="restrict", index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    effective_company_id = fields.Many2one(
        "res.company", string="Effective Company",
        compute="_compute_effective_company_id", store=True, index=True,
    )
    model_id = fields.Many2one(
        "ir.model", string="Target Model", required=True, ondelete="cascade",
    )
    model_name = fields.Char(related="model_id.model", string="Model Name", readonly=True)
    event_type = fields.Selection(
        EVENT_TYPES, string="Trigger Event", required=True, index=True,
    )
    domain_filter = fields.Char(
        string="Domain Filter",
        help="Optional domain filter expression evaluated against the triggering record, e.g. [('picking_type_code', '=', 'outgoing')]",
    )
    action_type = fields.Selection([
        ("report", "QWeb PDF Report"),
        ("raw_template", "Raw Command / Label Template"),
    ], string="Action Type", default="report", required=True)
    report_id = fields.Many2one(
        "ir.actions.report", string="Report Action", ondelete="restrict",
        domain="[('model', '=', model_name)]",
        help="Standard QWeb report to render into PDF.",
    )
    raw_protocol = fields.Selection([
        ("zpl", "Zebra ZPL-II"),
        ("tspl", "TSC TSPL"),
        ("escpos", "ESC/POS"),
    ], string="Raw Protocol", default="zpl")
    raw_template = fields.Text(
        string="Raw Command Template",
        help="Raw printer command string with optional {record.<field>} or {<field>} placeholders.",
    )
    binding_id = fields.Many2one(
        "print_gateway.binding", string="Target Binding", ondelete="restrict",
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
        help="Explicit print binding to use. If omitted, the standard routing engine will resolve the binding dynamically.",
    )
    warehouse_id = fields.Many2one(
        "stock.warehouse", string="Warehouse Filter", ondelete="restrict",
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
    )
    picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type Filter", ondelete="restrict",
        domain="['|', ('company_id', '=', False), ('company_id', '=', effective_company_id)]",
    )
    priority = fields.Integer(default=10, help="Lower numbers execute first.")

    def render_raw_template(self, record):
        """Deterministically render raw template string using record attributes."""
        self.ensure_one()
        template = self.raw_template or ""
        if not template:
            raise ValidationError(_("Raw template is empty for policy %s.") % self.name)
        values = {"record": record}
        for field_name in record._fields:
            try:
                values[field_name] = getattr(record, field_name)
            except Exception:
                pass
        try:
            return template.format(**values)
        except Exception as exc:
            raise ValidationError(
                _("Failed to render raw template for policy '%s' with record %s(%s): %s")
                % (self.name, record._name, record.id, exc)
            ) from exc

    @api.depends("company_id", "branch_id")
    def _compute_effective_company_id(self):
        for policy in self:
            policy.effective_company_id = policy.branch_id or policy.company_id

    @api.constrains("company_id", "branch_id")
    def _check_hierarchy(self):
        for policy in self:
            if policy.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a root company, not a branch."))
            if policy.branch_id and policy.branch_id.parent_id != policy.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))

    @api.constrains("action_type", "report_id", "raw_template", "raw_protocol", "domain_filter", "model_id")
    def _check_action_configuration(self):
        for policy in self:
            if policy.action_type == "report":
                if not policy.report_id:
                    raise ValidationError(_("A report must be selected when action type is 'QWeb PDF Report'."))
                if policy.report_id.model != policy.model_name:
                    raise ValidationError(_("Selected report model '%s' does not match policy target model '%s'.") % (policy.report_id.model, policy.model_name))
            elif policy.action_type == "raw_template":
                if not policy.raw_template or not policy.raw_template.strip():
                    raise ValidationError(_("Raw command template cannot be empty when action type is 'Raw Command / Label Template'."))
                if not policy.raw_protocol or policy.raw_protocol not in ("zpl", "tspl", "escpos"):
                    raise ValidationError(_("A valid raw protocol (ZPL, TSPL, or ESC/POS) must be specified."))
            if policy.domain_filter and policy.domain_filter.strip():
                try:
                    domain = safe_eval(policy.domain_filter)
                    if not isinstance(domain, list):
                        raise ValidationError(_("Domain filter must evaluate to a list of criteria."))
                except Exception as exc:
                    raise ValidationError(_("Invalid domain filter expression for policy '%s': %s") % (policy.name, exc)) from exc

    def matches_record(self, record):
        """Evaluate whether a given record satisfies the policy filters."""
        self.ensure_one()
        if not self.active:
            return False
        if record._name != self.model_name:
            return False

        # Multi-tenant scope check
        record_company = getattr(record, "company_id", False)
        if record_company:
            if self.branch_id and record_company != self.branch_id:
                return False
            if not self.branch_id and record_company.parent_id and record_company.parent_id != self.company_id:
                return False
            if not self.branch_id and not record_company.parent_id and record_company != self.company_id:
                return False

        # Specific warehouse / picking type filters (fail-closed if record cannot resolve attribute)
        if self.warehouse_id:
            record_warehouse = getattr(record, "warehouse_id", False) or (getattr(record, "picking_type_id", False) and record.picking_type_id.warehouse_id)
            if not record_warehouse or record_warehouse != self.warehouse_id:
                return False

        if self.picking_type_id:
            record_ptype = getattr(record, "picking_type_id", False)
            if not record_ptype or record_ptype != self.picking_type_id:
                return False

        # Domain filter check
        if self.domain_filter and self.domain_filter.strip():
            try:
                domain = safe_eval(self.domain_filter)
                if isinstance(domain, list):
                    matched = self.env[self.model_name].search([("id", "=", record.id)] + domain, limit=1)
                    if not matched:
                        return False
            except Exception:
                return False

        return True
