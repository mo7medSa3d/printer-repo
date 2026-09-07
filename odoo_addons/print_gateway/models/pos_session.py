# -*- coding: utf-8 -*-
"""POS session entry points for client-rendered print paths."""

from odoo import models, _
from odoo.exceptions import ValidationError


class PosSessionGatewayPrinting(models.Model):
    _inherit = "pos.session"

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        if self.company_id != self.env.company:
            raise ValidationError(_("Gateway printing must use the active Odoo company."))
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", self.env.company.id)], limit=1)
        return bool(config and config.enabled)

    def action_print_gateway_sale_details(self, image):
        self.ensure_one()
        if not image:
            raise ValidationError(_("The rendered Sale Details image is required."))
        return self.env["print_gateway.print_router"].route_pos_sale_details(self, image)
