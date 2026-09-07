# -*- coding: utf-8 -*-
"""Native Odoo print binding: Destination + Document Type -> Gateway Printer."""

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


DESTINATION_MODELS = [
    ("pos.config", "POS"),
    ("stock.picking.type", "Operation Type"),
    ("ir.actions.report", "Report"),
    ("res.company", "Company"),
]


class PrintGatewayBinding(models.Model):
    _name = "print_gateway.binding"
    _description = "Print Gateway Print Binding"
    _order = "priority, id"

    company_id = fields.Many2one(
        "res.company",
        required=True,
        default=lambda self: self.env.company,
        ondelete="restrict",
        index=True,
    )
    destination_ref = fields.Reference(
        selection=DESTINATION_MODELS,
        string="Destination",
        required=True,
        ondelete="restrict",
        help="Existing Odoo object that represents the print destination/context.",
    )
    document_type = fields.Char(
        required=True,
        help="Logical document type, for example receipt, invoice, order, delivery, or label.",
    )
    printer_id = fields.Char(
        string="Printer",
        required=True,
        index=True,
        help="Gateway runtime printer id. The Odoo module never creates or manages printers.",
    )
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is tried first.")
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
                destination,
                (record.document_type or "").strip().lower(),
                record.printer_id or "printer",
            )

    @api.constrains("destination_ref", "document_type", "printer_id", "company_id")
    def _check_binding(self):
        for record in self:
            if not record.destination_ref:
                raise ValidationError(_("Destination is required."))
            if not record.document_type or not record.document_type.strip():
                raise ValidationError(_("Document Type is required."))
            if not record.printer_id or not record.printer_id.strip():
                raise ValidationError(_("Printer is required."))
            destination = record.destination_ref
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company.id != record.company_id.id:
                raise ValidationError(
                    _("Destination %s belongs to another Odoo company.") % destination.display_name
                )
            if destination._name == "res.company" and destination.id != record.company_id.id:
                raise ValidationError(_("Company destination must match the binding company."))

    @staticmethod
    def normalize_document_type(value):
        return (value or "").strip().lower()

    @api.model
    def _candidate_values(self, report, record=None):
        """Return native Odoo destination objects from most to least specific."""
        candidates = []
        if record:
            if record._name == "pos.order" and "config_id" in record._fields and record.config_id:
                candidates.append(record.config_id)
            if record._name == "stock.picking" and "picking_type_id" in record._fields and record.picking_type_id:
                candidates.append(record.picking_type_id)
        if report:
            candidates.append(report)
        if record and "company_id" in record._fields and record.company_id:
            candidates.append(record.company_id)
        return candidates

    @api.model
    def find_for(self, company, document_type, report=None, record=None):
        document_type = self.normalize_document_type(document_type)
        if not document_type:
            return False
        candidates = self._candidate_values(report, record=record)
        domain = [
            ("company_id", "=", company.id),
            ("enabled", "=", True),
            ("document_type", "=", document_type),
        ]
        rows = self.search(domain, order="priority asc, id asc")
        candidate_keys = {
            "%s,%s" % (value._name, value.id): index
            for index, value in enumerate(candidates)
        }
        ranked = rows.filtered(
            lambda binding: "%s,%s" % (
                binding.destination_ref._name,
                binding.destination_ref.id,
            ) in candidate_keys
        )
        return ranked.sorted(
            key=lambda binding: (
                candidate_keys.get(
                    "%s,%s" % (
                        binding.destination_ref._name,
                        binding.destination_ref.id,
                    ),
                    999,
                ),
                binding.priority,
                binding.id,
            )
        )[:1]
