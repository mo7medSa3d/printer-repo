# -*- coding: utf-8 -*-
"""Durable Idempotent Intent tracking to prevent duplicate event-driven print dispatch."""

import datetime
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
        ("claimed", "Claimed / In Flight"),
        ("dispatched", "Dispatched"),
        ("skipped", "Skipped"),
        ("failed", "Routing Failed"),
    ], string="Dispatch Status", default="pending", required=True, index=True)

    attempts = fields.Integer(string="Attempt Count", default=0, required=True)
    max_attempts = fields.Integer(string="Max Attempts", default=3, required=True)
    next_retry_at = fields.Datetime(string="Next Retry At", index=True)
    last_error = fields.Text(string="Last Error", readonly=True)
    claimed_at = fields.Datetime(string="Claimed At", index=True)

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
        # 1. Atomically claim intent in fresh transaction
        try:
            with env.registry.cursor() as cr:
                new_env = api.Environment(cr, env.uid, dict(env.context))
                intent = new_env["print_gateway.intent"].browse(intent_id).exists()
                if not intent or intent.status in ("dispatched", "skipped"):
                    return
                now = fields.Datetime.now()
                intent.write({
                    "status": "claimed",
                    "claimed_at": now,
                    "attempts": intent.attempts + 1,
                })
                cr.commit()
        except Exception as exc:
            _logger.error("Failed to claim print intent %s: %s", intent_id, exc)
            return

        # 2. Execute route and update terminal/failure state
        try:
            with env.registry.cursor() as cr:
                new_env = api.Environment(cr, env.uid, dict(env.context))
                intent = new_env["print_gateway.intent"].browse(intent_id).exists()
                if not intent:
                    return
                record = new_env[res_model].browse(res_id).exists()
                if not record:
                    intent.write({
                        "status": "skipped",
                        "last_error": "Source record no longer exists",
                    })
                    cr.commit()
                    return
                router = new_env["print_gateway.print_router"]
                try:
                    route_res = router.route_intent(intent, record)
                    if route_res and route_res.get("job_id"):
                        intent.write({
                            "print_job_id": route_res["job_id"],
                            "status": "dispatched",
                            "last_error": False,
                        })
                    elif route_res and route_res.get("status") in ("skipped", "no_action"):
                        intent.write({"status": "skipped"})
                    else:
                        intent.write({"status": "dispatched", "last_error": False})
                    cr.commit()
                except Exception as exc:
                    _logger.warning("Failed to route print intent %s for %s(%s): %s", intent.intent_key[:12], res_model, res_id, exc)
                    next_retry = False
                    if intent.attempts < intent.max_attempts:
                        delay_sec = min(300, 15 * (2 ** max(0, intent.attempts - 1)))
                        next_retry = fields.Datetime.now() + datetime.timedelta(seconds=delay_sec)
                    intent.write({
                        "status": "failed" if intent.attempts >= intent.max_attempts else "pending",
                        "last_error": str(exc),
                        "next_retry_at": next_retry,
                    })
                    cr.commit()
        except Exception as exc:
            _logger.error("Error in postcommit print intent execution: %s", exc)

    @api.model
    def create_and_route(self, policy, record, event_type):
        """Idempotently creates intent or re-arms retryable intent and registers post-commit callback."""
        key = self.compute_intent_key(policy, record, event_type)
        existing = self.search([("intent_key", "=", key)], limit=1)
        if existing:
            if existing.status in ("dispatched", "skipped"):
                _logger.info("Print intent %s already completed (%s) for %s(%s); skipping duplicate dispatch.", key[:12], existing.status, record._name, record.id)
                return existing
            elif existing.status == "claimed":
                now = fields.Datetime.now()
                if existing.claimed_at and (now - existing.claimed_at).total_seconds() < 300:
                    _logger.info("Print intent %s is actively being processed by another worker; skipping duplicate dispatch.", key[:12])
                    return existing
            
            # Legitimate retry for pending, crashed-claimed, or failed intent
            if existing.status == "failed" and existing.attempts >= existing.max_attempts:
                _logger.info("Print intent %s was permanently failed; re-arming for explicit re-invocation.", key[:12])
                existing.write({"attempts": 0, "status": "pending", "last_error": False, "next_retry_at": False})
            elif existing.status in ("pending", "failed", "claimed"):
                existing.write({"status": "pending", "next_retry_at": False})

            intent_id = existing.id
            res_model = record._name
            res_id = record.id
            self.env.cr.postcommit.add(lambda: self._dispatch_intent_postcommit(self.env, intent_id, res_model, res_id))
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

    @api.model
    def cron_recover_pending_intents(self):
        """Recover stranded or crashed print intents across worker/server restarts."""
        now = fields.Datetime.now()
        stale_threshold = now - datetime.timedelta(minutes=5)

        candidates = self.search([
            "|",
            "&", ("status", "=", "pending"), "|", ("next_retry_at", "=", False), ("next_retry_at", "<=", now),
            "|",
            "&", ("status", "=", "claimed"), ("claimed_at", "<=", stale_threshold),
            "&", ("status", "=", "failed"), "&", ("attempts", "<", 3), ("next_retry_at", "<=", now),
        ], order="id asc", limit=50)

        recovered_count = 0
        for candidate in candidates:
            # Atomic conditional update prevents dual-dispatch between concurrent cron workers
            with self.env.registry.cursor() as cr:
                cr.execute("""
                    UPDATE print_gateway_intent
                    SET status = 'claimed', claimed_at = %s
                    WHERE id = %s AND (
                        status = 'pending' OR
                        (status = 'claimed' AND claimed_at <= %s) OR
                        (status = 'failed' AND attempts < max_attempts)
                    )
                """, (now, candidate.id, stale_threshold))
                if cr.rowcount == 0:
                    continue
                cr.commit()

            self._dispatch_intent_postcommit(self.env, candidate.id, candidate.res_model, candidate.res_id)
            recovered_count += 1

        return recovered_count
