# -*- coding: utf-8 -*-
"""Automated print policy hook for Stock Pickings."""

from odoo import models


class StockPickingPrintGateway(models.Model):
    _inherit = "stock.picking"

    def _action_done(self):
        res = super()._action_done()
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        policies = policy_model.search([
            ("model_id.model", "=", "stock.picking"),
            ("event_type", "=", "picking_validated"),
            ("active", "=", True),
        ], order="priority asc, id asc")

        if policies:
            for picking in self:
                for policy in policies:
                    if policy.matches_record(picking):
                        intent_model.create_and_route(policy, picking, "picking_validated")

        return res
