# -*- coding: utf-8 -*-
"""Automated print policy hook for Stock Pickings."""

import logging

from odoo import models

_logger = logging.getLogger(__name__)


class StockPickingPrintGateway(models.Model):
    _inherit = "stock.picking"

    def _action_done(self):
        res = super()._action_done()
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        for picking in self:
            # _action_done can return a backorder/batch wizard without
            # completing the picking; only validated (done) pickings print.
            if picking.state != "done":
                continue
            try:
                policies = policy_model.search([
                    ("model_id.model", "=", "stock.picking"),
                    ("event_type", "=", "picking_validated"),
                    ("company_id", "=", picking.company_id.id),
                    ("active", "=", True),
                ], order="priority asc, id asc")

                # Multi-destination fan-out with same-target dedup (e.g.
                # packing slip AND shipping label from distinct bindings).
                executed_targets = set()
                for policy in policies:
                    if policy.matches_record(picking):
                        target_key = (
                            policy.binding_id.id if policy.binding_id else False,
                            policy.action_type,
                            policy.report_id.id if policy.report_id else False,
                            policy.raw_template or False,
                        )
                        if target_key in executed_targets:
                            continue
                        executed_targets.add(target_key)
                        intent_model.create_and_route(policy, picking, "picking_validated")
                        break
            except Exception as exc:
                # Print scheduling must never break stock validation: log
                # per picking and continue, mirroring account_move handling.
                _logger.error("Failed to schedule print intent for picking %s: %s", picking.id, exc)

        return res
