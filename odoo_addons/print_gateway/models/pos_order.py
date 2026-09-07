# -*- coding: utf-8 -*-
from odoo import models


class PosOrderPrintGateway(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self):
        """Return a silent Gateway-print result for the POS frontend."""
        self.ensure_one()
        return self.env["print_gateway.print_router"].route_pos_receipt(self)
