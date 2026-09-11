# -*- coding: utf-8 -*-
"""Automated print policy hook for Account Moves (Invoices / Bills)."""

import logging
from odoo import models

_logger = logging.getLogger(__name__)


class AccountMovePrintGateway(models.Model):
    _inherit = "account.move"

    def action_post(self):
        res = super().action_post()
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        for move in self:
            try:
                if not move.is_invoice(include_receipts=True) or move.state != "posted":
                    continue
                policies = policy_model.search([
                    ("model_id.model", "=", "account.move"),
                    ("event_type", "=", "invoice_posted"),
                    ("company_id", "=", move.company_id.id),
                    ("active", "=", True),
                ], order="priority asc, id asc")

                # Multi-destination fan-out with same-target dedup: distinct
                # bindings print, but two policies resolving to the identical
                # target/content fire once.
                executed_targets = set()
                for policy in policies:
                    if policy.matches_record(move):
                        target_key = (
                            policy.binding_id.id if policy.binding_id else False,
                            policy.action_type,
                            policy.report_id.id if policy.report_id else False,
                            policy.raw_template or False,
                        )
                        if target_key in executed_targets:
                            continue
                        executed_targets.add(target_key)
                        intent_model.create_and_route(policy, move, "invoice_posted")
            except Exception as exc:
                _logger.error("Failed to schedule print intent for invoice %s: %s", move.id, exc)

        return res
