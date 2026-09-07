# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

from odoo import models


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self):
        self.ensure_one()
        return self.env["print_gateway.print_router"].route_pos_receipt(self)

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        company = self.company_id or self.env.company
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", company.id)], limit=1)
        return bool(config and config.enabled)
