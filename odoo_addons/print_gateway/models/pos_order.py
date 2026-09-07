# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

from odoo import models


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self):
        """Route the synchronized POS order through the central Odoo router."""
        self.ensure_one()
        return self.env["print_gateway.print_router"].route_pos_receipt(self)
