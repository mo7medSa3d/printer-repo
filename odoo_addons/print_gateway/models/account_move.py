# -*- coding: utf-8 -*-
"""Automated print policy hook for Account Moves (Invoices / Bills)."""

from odoo import models


class AccountMovePrintGateway(models.Model):
    _inherit = "account.move"

    def action_post(self):
        res = super().action_post()
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        policies = policy_model.search([
            ("model_id.model", "=", "account.move"),
            ("event_type", "=", "invoice_posted"),
            ("active", "=", True),
        ], order="priority asc, id asc")

        if policies:
            for move in self:
                if not move.is_invoice(include_receipts=True) or move.state != "posted":
                    continue
                for policy in policies:
                    if policy.matches_record(move):
                        intent_model.create_and_route(policy, move, "invoice_posted")

        return res
