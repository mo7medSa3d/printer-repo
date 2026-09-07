# -*- coding: utf-8 -*-
"""Native Odoo print bindings: Odoo context/report -> Gateway runtime printer."""

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
        ondelete="restrict", index=True,
    )
    destination_type = fields.Selection(
        DESTINATION_MODELS, string="Destination", required=True, default="pos",
    )
    destination_pos_config_id = fields.Many2one(
        "pos.config", string="POS Configuration", ondelete="restrict", check_company=True,
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
    )
    destination_pos_printer_id = fields.Many2one(
        "pos.printer", string="POS / Kitchen Printer", ondelete="restrict", check_company=True,
        domain="[('company_id', '=', company_id)]",
    )
    destination_picking_type_id = fields.Many2one(
        "stock.picking.type", string="Operation Type", ondelete="restrict", check_company=True,
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
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
        string="Destination Reference", compute="_compute_destination_ref", store=True, readonly=True,
    )
    report_id = fields.Many2one(
        "ir.actions.report", string="Document / Report", ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    document_type = fields.Char(
        string="Document Type", compute="_compute_document_type", store=True, readonly=True,
    )
    printer_id = fields.Char(string="Runtime Printer", required=True, index=True)
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)

    _priority_unique = models.Constraint(
        "UNIQUE(company_id, destination_ref, document_type, priority)",
        "Priority must be unique for the same destination and document type.",
    )

    @api.depends(
        "destination_type", "destination_pos_config_id", "destination_pos_printer_id",
        "destination_picking_type_id", "destination_report_id",
    )
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
                record.document_type = DOCUMENT_TYPE_BY_MODEL.get(
                    report.model,
                    "report:%s" % (report.report_name or report.id).strip().lower(),
                )
            else:
                record.document_type = False

    @api.depends("destination_ref", "document_type", "printer_id")
    def _compute_name(self):
        for record in self:
            destination = record.destination_ref.display_name if record.destination_ref else "Destination"
            record.name = "%s / %s → %s" % (
                destination, record.document_type or "document", record.printer_id or "Printer",
            )

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
            for field_name in (
                "destination_pos_config_id", "destination_pos_printer_id",
                "destination_picking_type_id", "destination_report_id", "report_id",
            ):
                value = record[field_name]
                if value and getattr(value, "company_id", False) and value.company_id != record.company_id:
                    record[field_name] = False

    @api.constrains(
        "destination_type", "destination_pos_config_id", "destination_pos_printer_id",
        "destination_picking_type_id", "destination_report_id", "report_id", "printer_id", "company_id",
    )
    def _check_binding(self):
        for record in self:
            destination = record.destination_ref
            if not destination:
                raise ValidationError(_("A valid Odoo destination is required."))
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company != record.company_id:
                raise ValidationError(_("Destination belongs to another Odoo company."))

            if record.destination_type == "pos_printer":
                printer_configs = record.destination_pos_printer_id.pos_config_ids
                if printer_configs and record.company_id not in printer_configs.mapped("company_id"):
                    raise ValidationError(_("POS / Kitchen Printer is not available to the selected Odoo company."))
                if record.report_id:
                    raise ValidationError(_("Kitchen bindings use the built-in Kitchen / Preparation document type."))
            else:
                if not record.report_id:
                    raise ValidationError(_("A real Odoo report must be selected for this destination type."))
                if record.report_id.model == "pos.order" and record.destination_type not in ("pos", "report"):
                    raise ValidationError(_("POS receipts must use a POS or report destination."))
                if record.report_id.model == "stock.picking" and record.destination_type not in ("picking_type", "report"):
                    raise ValidationError(_("Stock reports must use an operation type or report destination."))

            if not record.printer_id.strip():
                raise ValidationError(_("A runtime Gateway printer must be selected."))

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
    def find_for(self, company, document_type, report=None, record=None, explicit_destination=None):
        if company != self.env.company:
            raise ValidationError(_("Print binding resolution must use the active Odoo company."))
        normalized = (document_type or "").strip().lower()
        if not normalized:
            raise ValidationError(_("Print document type is required."))
        destination = self.destination_for(record=record, report=report, explicit_destination=explicit_destination)
        if getattr(destination, "company_id", False) and destination.company_id != company:
            raise ValidationError(_("Print destination belongs to another Odoo company."))
        return self.search([
            ("company_id", "=", company.id),
            ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized),
        ], order="priority asc, id asc", limit=1)
