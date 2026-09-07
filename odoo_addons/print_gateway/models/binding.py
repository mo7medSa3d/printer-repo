# -*- coding: utf-8 -*-
"""Native Odoo print binding: existing Odoo context + report -> Gateway runtime printer."""

import requests

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


DESTINATION_MODELS = [
    ("pos", "pos.config"),
    ("picking_type", "stock.picking.type"),
    ("report", "ir.actions.report"),
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
        DESTINATION_MODELS,
        string="Destination Type",
        required=True,
        default="pos",
    )
    destination_pos_config_id = fields.Many2one(
        "pos.config",
        string="POS Configuration",
        ondelete="restrict",
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
    )
    destination_picking_type_id = fields.Many2one(
        "stock.picking.type",
        string="Operation Type",
        ondelete="restrict",
        domain="[('company_id', '=', company_id), ('active', '=', True)]",
    )
    destination_report_id = fields.Many2one(
        "ir.actions.report",
        string="Report",
        ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    destination_ref = fields.Reference(
        selection=[(model, label) for model, label in [
            ("pos.config", "POS"),
            ("stock.picking.type", "Operation Type"),
            ("ir.actions.report", "Report"),
        ]],
        string="Destination Reference",
        compute="_compute_destination_ref",
        store=True,
        readonly=True,
    )
    report_id = fields.Many2one(
        "ir.actions.report",
        string="Document Type / Report",
        required=True,
        ondelete="restrict",
        domain="[('model', '!=', False)]",
    )
    document_type = fields.Char(
        string="Document Type",
        compute="_compute_document_type",
        store=True,
        readonly=True,
    )
    printer_id = fields.Selection(
        selection="_selection_printers",
        string="Printer",
        required=True,
    )
    enabled = fields.Boolean(default=True)
    priority = fields.Integer(default=10, help="Lower value is preferred when multiple bindings are valid.")
    name = fields.Char(compute="_compute_name", store=True)

    _priority_unique = models.Constraint(
        "UNIQUE(company_id, destination_ref, document_type, priority)",
        "Priority must be unique for the same destination and document type.",
    )

    @api.depends(
        "destination_type", "destination_pos_config_id", "destination_picking_type_id",
        "destination_report_id",
    )
    def _compute_destination_ref(self):
        for record in self:
            destination = False
            if record.destination_type == "pos":
                destination = record.destination_pos_config_id
            elif record.destination_type == "picking_type":
                destination = record.destination_picking_type_id
            elif record.destination_type == "report":
                destination = record.destination_report_id
            record.destination_ref = "%s,%s" % (destination._name, destination.id) if destination else False

    @api.depends("report_id")
    def _compute_document_type(self):
        for record in self:
            report = record.report_id
            if not report:
                record.document_type = False
                continue
            record.document_type = DOCUMENT_TYPE_BY_MODEL.get(
                report.model,
                "report:%s" % (report.report_name or report.id).strip().lower(),
            )

    @api.depends("company_id", "destination_ref", "document_type", "printer_id")
    def _compute_name(self):
        for record in self:
            destination = record.destination_ref.display_name if record.destination_ref else "Destination"
            record.name = "%s / %s → %s" % (
                destination, record.document_type or "document", record.printer_label,
            )

    @property
    def printer_label(self):
        self.ensure_one()
        choices = dict(self._selection_printers())
        return choices.get(self.printer_id, "Printer")

    @api.model
    def _selection_printers(self):
        config = self.env["print_gateway.gateway_config"].search(
            [("company_id", "=", self.env.company.id)], limit=1,
        )
        if not config or not config.enabled or not config.gateway_url or not config.gateway_api_key:
            return []
        try:
            response = requests.get(
                "%s/api/odoo/printers" % config.gateway_url.rstrip("/"),
                headers={
                    "Authorization": "Bearer %s" % config.gateway_api_key,
                    "X-Odoo-Database": self.env.cr.dbname,
                },
                timeout=(3, 5),
                allow_redirects=False,
            )
            if response.status_code != 200:
                return []
            payload = response.json()
        except (requests.RequestException, ValueError):
            return []
        printers = payload.get("printers") if isinstance(payload, dict) else None
        if not isinstance(printers, list):
            return []
        options = []
        for printer in printers:
            printer_id = str(printer.get("id") or "").strip()
            if not printer_id:
                continue
            name = str(printer.get("name") or printer_id).strip()
            status = str(printer.get("status") or "unknown").strip().lower()
            agent = printer.get("agent") or {}
            agent_name = str(agent.get("name") or "").strip()
            suffix = " · %s" % status if status else ""
            if agent_name:
                suffix += " · %s" % agent_name
            options.append((printer_id, "%s%s" % (name, suffix)))
        return options

    @api.onchange("destination_type")
    def _onchange_destination_type(self):
        for record in self:
            if record.destination_type != "pos":
                record.destination_pos_config_id = False
            if record.destination_type != "picking_type":
                record.destination_picking_type_id = False
            if record.destination_type != "report":
                record.destination_report_id = False

    @api.constrains("destination_type", "destination_pos_config_id", "destination_picking_type_id", "destination_report_id", "report_id", "printer_id", "company_id")
    def _check_binding(self):
        for record in self:
            destination = record.destination_ref
            if not destination:
                raise ValidationError(_("A valid Odoo destination is required."))
            destination_company = getattr(destination, "company_id", False)
            if destination_company and destination_company.id != record.company_id.id:
                raise ValidationError(_("Destination belongs to another Odoo company."))
            if record.report_id and record.report_id.model == "pos.order" and record.destination_type not in ("pos", "report"):
                raise ValidationError(_("POS receipts must use a POS or report destination."))
            if record.report_id and record.report_id.model == "stock.picking" and record.destination_type not in ("picking_type", "report"):
                raise ValidationError(_("Stock reports must use an operation type or report destination."))
            if not record.printer_id:
                raise ValidationError(_("A runtime Gateway printer must be selected."))

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
        normalized = (document_type or "").strip().lower()
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
