# -*- coding: utf-8 -*-
"""Native Odoo print binding: Destination + Document Type -> Gateway Printer."""

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


DESTINATION_MODELS = [
    ("pos.config", "POS"),
    ("stock.picking.type", "Operation Type"),
    ("ir.actions.report", "Report"),
]


class PrintGatewayBinding(models.Model):
    _name = "print_gateway.binding"
    _description = "Print Gateway Print Binding"
    _order = "priority, id"

    company_id = fields.Many2one(
        "res.company", required=True, default=lambda self: self.env.company,
        ondelete="restrict", index=True,
    )
    destination_ref = fields.Reference(
        selection=DESTINATION_MODELS,
        string="Destination",
        required=True,
        help="Existing Odoo object representing the deterministic print destination/context.",
    )
    document_type = fields.Char(required=True)
    printer_id = fields.Char(string="Runtime Printer ID", required=True, index=True)
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)

    _priority_unique = models.Constraint(
        "UNIQUE(company_id, destination_ref, document_type, priority)",
        "Priority must be unique for the same destination and document type.",
    )

    @api.depends("company_id", "destination_ref", "document_type", "printer_id")
    def _compute_name(self):
        for record in self:
            destination = record.destination_ref.display_name if record.destination_ref else "Destination"
            record.name = "%s / %s -> %s" % (
                destination, self.normalize_document_type(record.document_type), record.printer_id or "printer",
            )

    @api.constrains("destination_ref", "document_type", "printer_id", "company_id")
    def _check_binding(self):
        for record in self:
            if not record.destination_ref:
                raise ValidationError(_("Destination is required."))
            if record.destination_ref._name not in dict(DESTINATION_MODELS):
                raise ValidationError(_("Unsupported destination model."))
            if not record.document_type or not record.document_type.strip():
                raise ValidationError(_("Document Type is required."))
            if not record.printer_id or not record.printer_id.strip():
                raise ValidationError(_("Runtime Printer ID is required."))
            destination_company = getattr(record.destination_ref, "company_id", False)
            if destination_company and destination_company.id != record.company_id.id:
                raise ValidationError(_("Destination belongs to another Odoo company."))

    @staticmethod
    def normalize_document_type(value):
        return (value or "").strip().lower()

    @api.model
    def destination_for(self, *, record=None, report=None):
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
    def find_for(self, company, document_type, report=None, record=None):
        normalized = self.normalize_document_type(document_type)
        if not normalized:
            raise ValidationError(_("Print document type is required."))
        destination = self.destination_for(record=record, report=report)
        if getattr(destination, "company_id", False) and destination.company_id != company:
            raise ValidationError(_("Print destination belongs to another Odoo company."))
        rows = self.search([
            ("company_id", "=", company.id),
            ("enabled", "=", True),
            ("destination_ref", "=", "%s,%s" % (destination._name, destination.id)),
            ("document_type", "=", normalized),
        ], order="priority asc, id asc", limit=1)
        return rows[:1]
