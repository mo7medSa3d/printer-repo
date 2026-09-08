# -*- coding: utf-8 -*-
"""Durable Idempotent Intent tracking to prevent duplicate event-driven print dispatch."""

import hashlib
import logging

from psycopg2 import IntegrityError
from odoo import api, fields, models, _

_logger = logging.getLogger(__name__)


class PrintGatewayIntent(models.Model):
    _name = "print_gateway.intent"
    _description = "Print Gateway Dispatch Intent"
    _order = "create_date desc"

    intent_key = fields.Char(string="Idempotency Intent Key", required=True, index=True, readonly=True)
    policy_id = fields.Many2one("print_gateway.policy", string="Policy", required=True, ondelete="cascade")
    res_model = fields.Char(string="Source Model", required=True, index=True)
    res_id = fields.Integer(string="Source ID", required=True, index=True)
    event_type = fields.Char(string="Event Type", required=True)
    print_job_id = fields.Many2one("print_gateway.print_job", string="Resulting Outbox Job", ondelete="set null")

    _intent_unique = models.Constraint(
        "UNIQUE(intent_key)",
        "An automated print event with this identical intent key has already been captured.",
    )

    @api.model
    def compute_intent_key(self, policy, record, event_type):
        raw = f"{record._name}:{record.id}:{event_type}:{policy.id}:{record.write_date}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @api.model
    def create_and_route(self, policy, record, event_type):
        """Idempotently creates intent and triggers router dispatch. Suppresses duplicate submissions."""
        key = self.compute_intent_key(policy, record, event_type)
        existing = self.search([("intent_key", "=", key)], limit=1)
        if existing:
            _logger.info("Print intent %s already processed for %s(%s); skipping duplicate dispatch.", key[:12], record._name, record.id)
            return existing

        try:
            with self.env.cr.savepoint():
                intent = self.create({
                    "intent_key": key,
                    "policy_id": policy.id,
                    "res_model": record._name,
                    "res_id": record.id,
                    "event_type": event_type,
                })
        except IntegrityError:
            _logger.info("Concurrent intent creation detected for %s; skipping.", key[:12])
            return self.search([("intent_key", "=", key)], limit=1)

        # Route via Print Router
        router = self.env["print_gateway.print_router"]
        try:
            route_res = router.route_intent(intent, record)
            if route_res and route_res.get("job_id"):
                intent.sudo().write({"print_job_id": route_res["job_id"]})
        except Exception as exc:
            _logger.warning("Failed to route print intent %s for %s(%s): %s", key[:12], record._name, record.id, exc)

        return intent
