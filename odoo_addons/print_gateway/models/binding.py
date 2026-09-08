# -*- coding: utf-8 -*-
"""Native Odoo print bindings: Odoo context -> Gateway runtime printer."""

import requests

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


DESTINATION_MODELS = [
    ("pos", "POS Configuration"),
    ("pos_printer", "POS / Kitchen Printer"),
    ("picking_type", "Operation Type"),
    ("report", "Report"),
]

DOCUMENT_TYPE_BY_MODEL = {
    "sale.order": "order",
    "account.move": "invoice",
    "stock.picking": "delivery",
    "purchase.order": "purchase_order",
    "pos.order": "receipt",
}


class PrintGatewayBinding(models.Model):
    _name = "print_gateway.binding"
    _description = "Print Gateway Print Binding"
    _order = "priority, id"

    company_id = fields.Many2one(
        "res.company", required=True, default=lambda self: self.env.company,
        ondelete="restrict", index=True, string="Odoo Company",
        domain="[('parent_id', '=', False)]",
    )
    branch_id = fields.Many2one(
        "res.company", string="Odoo Branch", ondelete="restrict", index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    runtime_agent_id = fields.Char(
        string="Gateway Runtime Agent", copy=False, index=True,
        help="Opaque Gateway runtime-agent ID. Runtime ownership remains in the Gateway.",
    )
    destination_type = fields.Selection(
        DESTINATION_MODELS, string="Destination Type", required=True, default="pos",
    )
    destination_pos_config_id = fields.Many2one(
        "pos.config", string="POS Configuration", ondelete="restrict", check_company=True,
        domain="['&', '|', ('company_id', '=', False), ('company_id', '=', branch_id), ('active', '=', True)]",
    )
    destination_pos_printer_id = fields.Many2one(
        "pos.printer", string="POS / Kitchen Printer", ondelete="restrict", check_company=True,
        domain="['|', ('company_id', '=', False), ('company_id', '=', branch_id)]",
    )
    destination_picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type", ondelete="restrict", check_company=True,
        domain="['&', '|', ('company_id', '=', False), ('company_id', '=', branch_id), ('active', '=', True)]",
    )
    destination_report_id = fields.Many2one(
        "ir.actions.report", string="Report Destination", ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    destination_ref = fields.Reference(
        selection=[
            ("pos.config", "POS Configuration"),
            ("pos.printer", "POS / Kitchen Printer"),
            ("stock.picking.type", "Operation Type"),
            ("ir.actions.report", "Report"),
        ],
        string="Odoo Destination", compute="_compute_destination_ref", store=True, readonly=True,
    )
    report_id = fields.Many2one(
        "ir.actions.report", string="Document / Report", ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    document_type = fields.Char(
        string="Document Type", compute="_compute_document_type", store=True, readonly=True,
    )
    printer_id = fields.Char(
        string="Gateway Runtime Printer", required=True, index=True, copy=False,
    )
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)

    _priority_unique = models.Constraint(
        "UNIQUE(company_id, branch_id, destination_ref, document_type, priority)",
        "Priority must be unique for the same Odoo company, branch, destination and document type.",
    )

    @api.depends("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id")
    def _compute_destination_ref(self):
        for record in self:
            destination = False
            if record.destination_type == "pos":
                destination = record.destination_pos_config_id
            elif record.destination_type == "pos_printer":
                destination = record.destination_pos_printer_id
            elif record.destination_type == "picking_type":
                destination = record.destination_picking_type_id
            elif record.destination_type == "report":
                destination = record.destination_report_id
            record.destination_ref = "%s,%s" % (destination._name, destination.id) if destination else False

    @api.depends("report_id", "destination_type", "destination_pos_printer_id")
    def _compute_document_type(self):
        for record in self:
            if record.destination_type == "pos_printer":
                record.document_type = "kitchen"
            elif record.report_id:
                report = record.report_id
                record.document_type = DOCUMENT_TYPE_BY_MODEL.get(report.model, "report:%s" % (report.report_name or report.id).strip().lower())
            else:
                record.document_type = False

    @api.depends("company_id", "branch_id", "destination_ref", "document_type", "runtime_agent_id", "printer_id")
    def _compute_name(self):
        for record in self:
            destination = record.destination_ref.display_name if record.destination_ref else "Destination"
            scope = record.branch_id.display_name if record.branch_id else record.company_id.display_name
            agent = record.runtime_agent_id or "Agent"
            printer = record.printer_id or "Printer"
            record.name = "%s / %s / %s → %s / %s" % (scope or "Odoo Context", destination, record.document_type or "document", agent, printer)

    @api.onchange("destination_type")
    def _onchange_destination_type(self):
        for record in self:
            if record.destination_type != "pos":
                record.destination_pos_config_id = False
            if record.destination_type != "pos_printer":
                record.destination_pos_printer_id = False
            if record.destination_type != "picking_type":
                record.destination_picking_type_id = False
            if record.destination_type != "report":
                record.destination_report_id = False
            if record.destination_type == "pos_printer":
                record.report_id = False

    @api.onchange("company_id")
    def _onchange_company_id(self):
        for record in self:
            record.branch_id = False
            record.runtime_agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.onchange("branch_id")
    def _onchange_branch_id(self):
        for record in self:
            record.runtime_agent_id = False
            record.printer_id = False
            record.destination_pos_config_id = False
            record.destination_pos_printer_id = False
            record.destination_picking_type_id = False
            record.destination_report_id = False
            record.report_id = False

    @api.onchange("runtime_agent_id")
    def _onchange_runtime_agent_id(self):
        for record in self:
            record.printer_id = False

    def _get_gateway_config(self):
        self.ensure_one()
        root_company = self.company_id.parent_id if self.branch_id and self.company_id.parent_id else self.company_id
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config or not config.enabled:
            raise ValidationError(_("An enabled Print Gateway configuration is required for this Odoo Company."))
        return config

    def _validate_runtime_target(self):
        self.ensure_one()
        if not self.branch_id or not self.runtime_agent_id:
            return
        config = self._get_gateway_config()
        try:
            response = requests.get("%s/api/odoo/agents" % config._gateway_base(for_request=True), headers=config._gateway_headers(), timeout=(5, 10), allow_redirects=False)
            if response.status_code != 200:
                raise ValidationError(_("Gateway agent discovery failed (HTTP %s).") % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(_("Gateway runtime agent discovery is unavailable.")) from exc
        agents = body.get("agents") if isinstance(body, dict) else None
        selected_agent = next((agent for agent in agents or [] if isinstance(agent, dict) and agent.get("id") == self.runtime_agent_id and agent.get("lifecycle", "active") != "retired"), None)
        if not isinstance(agents, list) or not selected_agent:
            raise ValidationError(_("The selected Gateway Runtime Agent is not an active runtime agent."))
        try:
            response = requests.get("%s/api/odoo/printers" % config._gateway_base(for_request=True), headers=config._gateway_headers(), timeout=(5, 10), allow_redirects=False)
            if response.status_code != 200:
                raise ValidationError(_("Gateway printer discovery failed (HTTP %s).") % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(_("Gateway runtime printer discovery is unavailable.")) from exc
        printers = body.get("printers") if isinstance(body, dict) else None
        selected_printer = next((printer for printer in printers or [] if isinstance(printer, dict) and printer.get("id") == self.printer_id and printer.get("lifecycle", "active") != "retired"), None)
        if not isinstance(printers, list) or not selected_printer:
            raise ValidationError(_("The selected Gateway Runtime Printer is not an active runtime printer."))
        agent = selected_printer.get("agent") if isinstance(selected_printer.get("agent"), dict) else {}
        if agent.get("id") != self.runtime_agent_id:
            raise ValidationError(_("Gateway Runtime Printer does not belong to the selected Runtime Agent."))
        device_class = str(selected_printer.get("deviceClass") or "").strip().lower()
        if self.destination_type in ("pos", "pos_printer") and device_class in ("laser", "inkjet"):
            raise ValidationError(_("Point of Sale receipts require a thermal receipt printer, not a document/laser printer."))
        if self.destination_type == "picking_type" and device_class in ("laser", "inkjet") and not self.report_id:
            raise ValidationError(_("Direct inventory/warehouse operations require a label or thermal printer."))


    @api.constrains("company_id", "branch_id")
    def _check_company_hierarchy(self):
        for record in self:
            if record.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a root Company, not a Branch."))
            if record.branch_id and record.branch_id.parent_id != record.company_id:
                raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))

    @api.constrains("company_id", "branch_id", "runtime_agent_id", "printer_id")
    def _check_runtime_scope(self):
        for record in self:
            if record.company_id not in self.env.companies:
                raise ValidationError(_("The selected Odoo Company is not available to the current user."))
            if record.branch_id:
                if record.branch_id not in self.env.companies:
                    raise ValidationError(_("Odoo Branch is not available to the current user."))
                if not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip():
                    raise ValidationError(_("A Gateway Runtime Agent is required for a branch binding."))
                record._validate_runtime_target()

    @api.constrains("destination_type", "destination_pos_config_id", "destination_pos_printer_id", "destination_picking_type_id", "destination_report_id", "report_id", "printer_id", "company_id", "branch_id")
    def _check_binding(self):
        for record in self:
            destination = record.destination_ref
            if not destination:
                raise ValidationError(_("A valid Odoo Destination is required."))
            expected_company = record.branch_id or record.company_id
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company != expected_company:
                raise ValidationError(_("Odoo Destination belongs to another company/branch context."))
            if record.report_id and getattr(record.report_id, "company_id", False) and record.report_id.company_id != expected_company:
                raise ValidationError(_("Document / Report belongs to another company/branch context."))
            if record.destination_type == "pos_printer":
                printer_configs = record.destination_pos_printer_id.pos_config_ids
                if printer_configs and expected_company not in printer_configs.mapped("company_id"):
                    raise ValidationError(_("POS / Kitchen Printer is not available to the selected Odoo Branch."))
                if record.report_id:
                    raise ValidationError(_("Kitchen bindings use the built-in Kitchen / Preparation document type."))
            elif not record.report_id:
                raise ValidationError(_("A real Odoo report must be selected for this Destination Type."))
            if record.report_id and record.report_id.model == "pos.order" and record.destination_type not in ("pos", "report"):
                raise ValidationError(_("POS receipts must use a POS or report destination."))
            if record.report_id and record.report_id.model == "stock.picking" and record.destination_type not in ("picking_type", "report"):
                raise ValidationError(_("Stock reports must use an operation type or report destination."))
            if not isinstance(record.printer_id, str) or not record.printer_id.strip():
                raise ValidationError(_("A Gateway Runtime Printer must be selected."))

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for record in records:
            record._sync_runtime_assignment()
        return records

    def _sync_runtime_assignment(self):
        self.ensure_one()
        if not self.branch_id or not self.runtime_agent_id:
            return
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        assignment = assignment_model.search([("company_id", "=", self.company_id.id), ("branch_id", "=", self.branch_id.id)], limit=1)
        if assignment:
            if assignment.runtime_agent_id != self.runtime_agent_id:
                other_bindings = self.search([
                    ("id", "!=", self.id), ("company_id", "=", self.company_id.id),
                    ("branch_id", "=", self.branch_id.id), ("runtime_agent_id", "!=", self.runtime_agent_id),
                ], limit=1)
                if other_bindings:
                    raise ValidationError(_("The selected Odoo Branch is already assigned to another Gateway Runtime Agent."))
                assignment.write({"runtime_agent_id": self.runtime_agent_id, "enabled": True})
            return
        assignment_model.create({"company_id": self.company_id.id, "branch_id": self.branch_id.id, "runtime_agent_id": self.runtime_agent_id, "enabled": True})

    def write(self, vals):
        result = super().write(vals)
        if set(vals).intersection({"company_id", "branch_id", "runtime_agent_id"}):
            for record in self:
                record._sync_runtime_assignment()
        return result

    @api.model
    def destination_for(self, *, record=None, report=None, explicit_destination=None):
        if explicit_destination:
            return explicit_destination
        if record and record._name == "pos.order":
            config = getattr(record, "config_id", False)
            if config:
                return config
            raise ValidationError(_("POS order has no POS configuration for print routing."))
        if record and record._name == "stock.picking":
            picking_type = getattr(record, "picking_type_id", False)
            if picking_type:
                return picking_type
            raise ValidationError(_("Delivery has no operation type for print routing."))
        if report:
            return report
        raise ValidationError(_("A deterministic Odoo print destination is required."))

    @api.model
    def find_for(self, company, document_type, report=None, record=None, explicit_destination=None, branch=None):
        normalized = (document_type or "").strip().lower()
        if not normalized:
            raise ValidationError(_("Print document type is required."))
        destination = self.destination_for(record=record, report=report, explicit_destination=explicit_destination)
        expected_company = branch or company
        destination_company = getattr(destination, "company_id", False)
        if destination_company and destination_company != expected_company:
            raise ValidationError(_("Print destination belongs to another Odoo company/branch context."))
        domain = [
            ("company_id", "=", company.id), ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized), ("branch_id", "=", branch.id if branch else False),
        ]
        binding = self.search(domain, order="priority asc, id asc", limit=1)
        if binding or not branch:
            return binding
        return self.search([
            ("company_id", "=", company.id), ("branch_id", "=", False), ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized),
        ], order="priority asc, id asc", limit=1)

    @api.model
    def dispatch_report_action(self, report_name=None, res_ids=None, context=None):
        context = dict(context or self.env.context)
        report = self.env["ir.actions.report"].search([("report_name", "=", report_name)], limit=1)
        if not report:
            return {"dispatched": False, "has_binding": False}

        records = self.env[report.model].browse(res_ids or []).exists()
        router = self.env["print_gateway.print_router"]
        config = router._gateway_config(self.env.company)
        if not config:
            return {"dispatched": False, "has_binding": False}

        try:
            gateway_company, branch = router._binding_scope(self.env.company)
            dtype = router._document_type(report=report, record=records[0] if records else None)
            destination = router.destination_for(report=report, record=records[0] if records else None)
            binding = self.find_for(
                gateway_company,
                dtype,
                report=report,
                record=records[0] if records else None,
                branch=branch,
            )
        except Exception as exc:
            return {
                "has_binding": True,
                "success": False,
                "dispatched": False,
                "error": str(exc),
                "fail_closed": True,
            }

        if not binding:
            return {"dispatched": False, "has_binding": False, "success": False}

        try:
            route = router.route_report(report, records)
            if route.get("native"):
                return {"dispatched": False, "has_binding": False, "success": False}

            return {
                "dispatched": True,
                "success": True,
                "has_binding": True,
                "printer_name": route.get("printer_id") or binding.printer_id,
                "message": route.get("message") or _("Sent silently to printer."),
            }
        except Exception as exc:
            return {
                "dispatched": False,
                "success": False,
                "has_binding": True,
                "error": str(exc),
                "fail_closed": True,
            }

