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

    status = fields.Selection([
        ("pending", "Pending Commit"),
        ("dispatched", "Dispatched"),
        ("skipped", "Skipped"),
        ("failed", "Routing Failed"),
    ], string="Dispatch Status", default="pending", required=True, index=True)

    _intent_unique = models.Constraint(
        "UNIQUE(intent_key)",
        "An automated print event with this identical intent key has already been captured.",
    )

    @api.model
    def compute_intent_key(self, policy, record, event_type):
        raw = f"{record._name}:{record.id}:{event_type}:{policy.id}:{record.write_date}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @classmethod
    def _dispatch_intent_postcommit(cls, env, intent_id, res_model, res_id):
        """Execute network/gateway dispatch strictly after the enclosing database transaction commits."""
        try:
            with env.registry.cursor() as cr:
                new_env = api.Environment(cr, env.uid, dict(env.context))
                intent = new_env["print_gateway.intent"].browse(intent_id).exists()
                if not intent:
                    return
                record = new_env[res_model].browse(res_id).exists()
                if not record:
                    intent.write({"status": "skipped"})
                    cr.commit()
                    return
                router = new_env["print_gateway.print_router"]
                try:
                    route_res = router.route_intent(intent, record)
                    if route_res and route_res.get("job_id"):
                        intent.write({
                            "print_job_id": route_res["job_id"],
                            "status": "dispatched",
                        })
                    elif route_res and route_res.get("status") in ("skipped", "no_action"):
                        intent.write({"status": "skipped"})
                    else:
                        intent.write({"status": "dispatched"})
                    cr.commit()
                except Exception as exc:
                    _logger.warning("Failed to route print intent %s for %s(%s): %s", intent.intent_key[:12], res_model, res_id, exc)
                    intent.write({"status": "failed"})
                    cr.commit()
        except Exception as exc:
            _logger.error("Error in postcommit print intent execution: %s", exc)

    @api.model
    def create_and_route(self, policy, record, event_type):
        """Idempotently creates intent and registers post-commit dispatch callback."""
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
                    "status": "pending",
                })
        except IntegrityError:
            _logger.info("Concurrent intent creation detected for %s; skipping.", key[:12])
            return self.search([("intent_key", "=", key)], limit=1)

        # Register post-commit hook so Gateway dispatch happens ONLY after PostgreSQL commit
        intent_id = intent.id
        res_model = record._name
        res_id = record.id
        self.env.cr.postcommit.add(lambda: self._dispatch_intent_postcommit(self.env, intent_id, res_model, res_id))

        return intent

