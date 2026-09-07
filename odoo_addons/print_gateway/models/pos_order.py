# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

from odoo import models, _
from odoo.exceptions import ValidationError


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self):
        self.ensure_one()
        return self.env["print_gateway.print_router"].route_pos_receipt(self)

    def action_print_gateway_kitchen(self, printer_id, image, reprint=False):
        self.ensure_one()
        if not printer_id:
            raise ValidationError(_("The Odoo Kitchen / Preparation printer is required."))
        try:
            printer = self.env["pos.printer"].browse(int(printer_id)).exists()
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("The selected Kitchen / Preparation printer is invalid.")) from exc
        if not printer:
            raise ValidationError(_("The selected Kitchen / Preparation printer no longer exists."))
        if printer.company_id != self.company_id:
            raise ValidationError(_("The selected Kitchen / Preparation printer belongs to another Odoo company."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, printer, image, reprint=bool(reprint),
        )

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        company = self.company_id or self.env.company
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", company.id)], limit=1)
        return bool(config and config.enabled)
