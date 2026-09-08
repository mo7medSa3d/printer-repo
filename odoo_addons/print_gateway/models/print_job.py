# -*- coding: utf-8 -*-
"""Durable Odoo-side print outbox and retry state."""

import datetime
import json
import logging
import time
import uuid

import requests
from psycopg2 import IntegrityError

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


_logger = logging.getLogger(__name__)


class PrintGatewayJob(models.Model):
    _name = "print_gateway.print_job"
    _description = "Print Gateway Job"
    _order = "create_date desc"

    company_id = fields.Many2one("res.company", required=True, ondelete="restrict", index=True)
    gateway_config_id = fields.Many2one("print_gateway.gateway_config", required=True, ondelete="restrict", index=True)
    gateway_job_id = fields.Char(string="Gateway Job ID", index=True, copy=False, readonly=True)
    printer_id = fields.Char(string="Printer", required=True, index=True, readonly=True)
    destination = fields.Char(required=True, readonly=True)
    document_type = fields.Char(required=True, readonly=True)
    status = fields.Selection([
        ("queued", "Queued"), ("submitted", "Submitted"), ("claimed", "Claimed"),
        ("printing", "Printing"), ("success", "Success"), ("failed", "Failed"),
        ("unknown", "Unknown Outcome"),
        ("partial", "Attention / Partial Delivery"),
    ], default="queued", required=True, index=True)
    physical_outcome = fields.Selection([
        ("not_printed", "Definitely not printed"),
        ("printed", "Definitely printed"),
        ("unknown", "Possibly printed / unknown"),
    ], compute="_compute_physical_outcome")
    payload = fields.Text(required=True, copy=False, readonly=True)
    idempotency_key = fields.Char(required=True, index=True, copy=False, readonly=True)
    attempts = fields.Integer(default=0, readonly=True)
    reprint_attempt_count = fields.Integer(string="Reprint Attempts", default=0, readonly=True)
    next_retry_at = fields.Datetime(index=True, readonly=True)
    last_error = fields.Text(readonly=True)
    source_model = fields.Char(readonly=True)
    source_record_id = fields.Integer(readonly=True)
    report_id = fields.Many2one("ir.actions.report", readonly=True, ondelete="set null")
    create_date = fields.Datetime(readonly=True)
    write_date = fields.Datetime(readonly=True)
    completed_at = fields.Datetime(readonly=True)

    _idempotency_unique = models.Constraint(
        "UNIQUE(company_id, idempotency_key)",
        "The same logical print operation may only be created once.",
    )
    _TERMINAL = frozenset(("success", "failed", "partial", "unknown"))

    _VALID_TRANSITIONS = {
        "queued": {"queued", "submitted", "claimed", "printing", "success", "failed", "partial", "unknown"},
        "submitted": {"submitted", "claimed", "printing", "success", "failed", "partial", "unknown"},
        "claimed": {"claimed", "printing", "success", "failed", "partial", "unknown"},
        "printing": {"printing", "success", "failed", "partial", "unknown"},
        "success": {"success"},
        "failed": {"failed", "queued"},
        "partial": {"partial", "queued"},
        "unknown": {"unknown", "queued"},
    }

    def write(self, vals):
        if "status" in vals:
            target_status = vals["status"]
            for job in self:
                if job.status and target_status != job.status:
                    allowed = self._VALID_TRANSITIONS.get(job.status, set())
                    if target_status not in allowed:
                        raise ValidationError(
                            _("Invalid print job state transition from '%s' to '%s'.")
                            % (job.status, target_status)
                        )
        return super().write(vals)

    @api.depends("status", "last_error")
    def _compute_physical_outcome(self):
        for job in self:
            if job.status == "success":
                job.physical_outcome = "printed"
            elif (
                job.status in ("unknown", "partial")
                or "UNKNOWN_PARTIAL_DELIVERY" in str(job.last_error or "")
                or str(job.last_error or "").startswith("UNKNOWN_SUBMISSION_OUTCOME")
            ):
                job.physical_outcome = "unknown"
            else:
                job.physical_outcome = "not_printed"

    @api.model
    def create_operation(self, *, company, gateway_config, printer_id, destination, document_type,
                         payload, source_model=None, source_record_id=None, report=None,
                         idempotency_key=None):
        if not company or not gateway_config:
            raise ValidationError(_("Gateway configuration is missing."))
        if company != self.env.company:
            raise ValidationError(_("Print operations must be created in the active Odoo company."))
        expected_config_owner = company.parent_id or company
        if gateway_config.company_id != expected_config_owner:
            raise ValidationError(_("Gateway configuration does not belong to the company hierarchy of the active Odoo company."))
        if not printer_id or not str(printer_id).strip():
            raise ValidationError(_("Printer is required."))
        if not destination or not str(destination).strip():
            raise ValidationError(_("Destination is required."))
        if not document_type or not str(document_type).strip():
            raise ValidationError(_("Document type is required."))
        try:
            payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Print payload is not JSON serializable.")) from exc
        if len(payload_json.encode("utf-8")) > 8 * 1024 * 1024:
            raise ValidationError(_("Print payload exceeds the 8 MiB safety limit."))

        key = (idempotency_key or uuid.uuid4().hex).strip()

        def same_operation(existing):
            return (
                existing.printer_id == str(printer_id).strip()
                and existing.destination == str(destination).strip()
                and existing.document_type == str(document_type).strip().lower()
                and existing.payload == payload_json
            )

        existing = self.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
        if existing:
            if not same_operation(existing):
                raise ValidationError(_("The idempotency key is already used for a different print operation."))
            return existing

        values = {
            "company_id": company.id,
            "gateway_config_id": gateway_config.id,
            "printer_id": str(printer_id).strip(),
            "destination": str(destination).strip(),
            "document_type": str(document_type).strip().lower(),
            "status": "queued",
            "payload": payload_json,
            "idempotency_key": key,
            "next_retry_at": fields.Datetime.now(),
            "source_model": source_model or False,
            "source_record_id": source_record_id or False,
            "report_id": report.id if report else False,
        }
        try:
            with self.env.cr.savepoint():
                return self.create(values)
        except IntegrityError:
            existing = self.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
            if existing:
                if not same_operation(existing):
                    raise ValidationError(_("The idempotency key is already used for a different print operation."))
                return existing
            raise

    def _persist_state(self, values):
        self.ensure_one()
        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            env["print_gateway.print_job"].browse(self.id).write(values)
            cr.commit()

    def _submission_body(self):
        self.ensure_one()
        try:
            payload = json.loads(self.payload)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Stored print payload is corrupted.")) from exc
        return {
            "printerId": self.printer_id,
            "documentType": self.document_type,
            "destination": self.destination,
            "payload": payload,
            "idempotencyKey": self.idempotency_key,
        }

    def action_submit(self, raise_on_failure=False):
        for job in self:
            if job.status in self._TERMINAL and job.gateway_job_id:
                continue
            gateway_config = job.gateway_config_id.sudo()
            try:
                response = requests.post(
                    "%s/api/print/jobs" % gateway_config._gateway_base(for_request=True),
                    json=job._submission_body(), headers=gateway_config._gateway_headers(),
                    timeout=(5, 20), allow_redirects=False,
                )
                if response.status_code not in (200, 201):
                    raise RuntimeError("GATEWAY_HTTP_%s" % response.status_code)
                body = response.json()
                remote_id = body.get("jobId") or body.get("id")
                if not remote_id:
                    raise RuntimeError("GATEWAY_INVALID_RESPONSE")
                remote_status = str(body.get("status") or "queued").strip().lower()
                if remote_status == "completed":
                    remote_status = "success"
                if remote_status not in {"queued", "submitted", "claimed", "printing", "success", "failed", "unknown"}:
                    remote_status = "submitted"
                job.write({
                    "gateway_job_id": str(remote_id),
                    "status": "submitted" if remote_status == "queued" else remote_status,
                    "attempts": job.attempts + 1, "last_error": False, "next_retry_at": False,
                })
            except requests.exceptions.Timeout as exc:
                values = {
                    "status": "unknown",
                    "attempts": job.attempts + 1,
                    "last_error": "UNKNOWN_SUBMISSION_OUTCOME: gateway request timed out (ambiguous dispatch)",
                    "next_retry_at": False,
                }
                if raise_on_failure:
                    job._persist_state(values)
                else:
                    job.write(values)
                _logger.warning("Gateway submission timed out; outcome is unknown for job %s", job.idempotency_key[:8])
                if raise_on_failure:
                    raise ValidationError(_("Gateway submission timed out; physical outcome is unknown. Automated retries are paused to prevent duplicate prints. Operator reprint required.")) from exc
            except requests.exceptions.ConnectionError as exc:
                next_attempt = job.attempts + 1
                terminal = next_attempt >= 5
                retry_delay = min(300, 10 * (2 ** min(next_attempt - 1, 5)))
                next_retry = False if terminal else fields.Datetime.now() + datetime.timedelta(seconds=retry_delay)
                values = {
                    "status": "failed" if terminal else "queued",
                    "attempts": next_attempt,
                    "last_error": "CONNECTION_ERROR: %s" % str(exc)[:4000],
                    "next_retry_at": next_retry,
                    "completed_at": fields.Datetime.now() if terminal else False,
                }
                if raise_on_failure:
                    job._persist_state(values)
                else:
                    job.write(values)
                _logger.warning("Gateway connection failed for job %s (attempt %s/5)", job.idempotency_key[:8], next_attempt)
                if raise_on_failure:
                    raise ValidationError(_("Gateway connection failed: %s") % str(exc)[:500]) from exc
            except requests.RequestException as exc:
                next_attempt = job.attempts + 1
                terminal = next_attempt >= 5
                values = {
                    "status": "failed" if terminal else "queued",
                    "attempts": next_attempt,
                    "last_error": "GATEWAY_TRANSPORT_ERROR: %s" % str(exc)[:4000],
                    "next_retry_at": False if terminal else fields.Datetime.now() + datetime.timedelta(seconds=15),
                    "completed_at": fields.Datetime.now() if terminal else False,
                }
                if raise_on_failure:
                    job._persist_state(values)
                else:
                    job.write(values)
                if raise_on_failure:
                    raise ValidationError(_("Gateway request failed: %s") % str(exc)[:500]) from exc
            except (ValueError, RuntimeError, ValidationError) as exc:
                next_attempt = job.attempts + 1
                terminal = next_attempt >= 5
                values = {
                    "status": "failed" if terminal else "queued", "attempts": next_attempt,
                    "last_error": str(exc)[:4000],
                    "next_retry_at": False if terminal else fields.Datetime.now(),
                    "completed_at": fields.Datetime.now() if terminal else False,
                }
                if raise_on_failure:
                    job._persist_state(values)
                else:
                    job.write(values)
                if raise_on_failure:
                    raise ValidationError(_("Gateway submission failed: %s") % str(exc)[:500]) from exc
        return True

    def action_sync_status(self):
        for job in self.filtered(lambda row: row.gateway_job_id and row.status not in self._TERMINAL):
            gateway_config = job.gateway_config_id.sudo()
            try:
                response = requests.get(
                    "%s/api/print/jobs" % gateway_config._gateway_base(for_request=True),
                    params={"id": job.gateway_job_id}, headers=gateway_config._gateway_headers(),
                    timeout=(5, 10), allow_redirects=False,
                )
                if response.status_code == 404:
                    continue
                response.raise_for_status()
                body = response.json()
                status = str(body.get("status") or "").strip().lower()
                if status == "completed":
                    status = "success"
                elif status == "expired":
                    status = "failed"
                    if not body.get("error"):
                        body["error"] = "GATEWAY_JOB_EXPIRED: Gateway lease or expiration window elapsed before job was claimed or printed"
                if status not in {"submitted", "claimed", "printing", "success", "failed", "unknown"}:
                    continue
                err_msg = body.get("error") or False
                if err_msg and "UNKNOWN_PARTIAL_DELIVERY" in str(err_msg):
                    status = "partial"
                values = {"status": status, "last_error": err_msg}
                if status in self._TERMINAL:
                    values["completed_at"] = fields.Datetime.now()
                job.write(values)
            except (requests.RequestException, ValueError):
                _logger.warning("Gateway status sync failed for job %s", job.idempotency_key[:8])
        return True

    def action_retry(self):
        """Create a new logical print operation only from a definitely failed job.

        Unknown physical outcomes are never retried from the UI. A failed job that
        is definitely not printed gets a fresh idempotency key so the new operation
        is not collapsed into the old Gateway job.
        """
        for job in self.filtered(lambda row: row.status == "failed" and row.physical_outcome == "not_printed"):
            retry = self.create_operation(
                company=job.company_id,
                gateway_config=job.gateway_config_id,
                printer_id=job.printer_id,
                destination=job.destination,
                document_type=job.document_type,
                payload=json.loads(job.payload),
                source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=uuid.uuid4().hex,
            )
            retry.action_submit()
        return True

    def action_force_reprint(self):
        """Explicitly re-issue print operation for jobs with partial delivery or unknown physical outcome.

        This requires conscious operator action, preventing automated double printing of receipts/invoices.
        Generates a deterministic derived idempotency key: ${original_key}-reprint-${reprint_attempt_count}.
        """
        for job in self.filtered(lambda row: row.status in ("partial", "unknown") or row.physical_outcome == "unknown"):
            new_count = (job.reprint_attempt_count or 0) + 1
            job.write({"reprint_attempt_count": new_count})
            derived_key = "%s-reprint-%d" % (job.idempotency_key, new_count)
            _logger.info(
                "Force reprint requested for print job %s (attempt %d, derived key: %s)",
                job.id, new_count, derived_key,
            )
            retry = self.create_operation(
                company=job.company_id,
                gateway_config=job.gateway_config_id,
                printer_id=job.printer_id,
                destination=job.destination,
                document_type=job.document_type,
                payload=json.loads(job.payload),
                source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=derived_key,
            )
            retry.action_submit()
        return True

    @api.model
    def cron_submit_pending(self):
        now = fields.Datetime.now()
        jobs = self.search([
            ("status", "=", "queued"), "|",
            ("next_retry_at", "=", False), ("next_retry_at", "<=", now),
        ], order="id asc", limit=50)
        started = time.monotonic()
        for job in jobs:
            if time.monotonic() - started > 20:
                break
            job.action_submit()
        return len(jobs)

    @api.model
    def cron_sync_status(self):
        jobs = self.search([
            ("gateway_job_id", "!=", False),
            ("status", "not in", list(self._TERMINAL)),
        ], order="id asc", limit=100)
        for job in jobs:
            job.action_sync_status()
        return len(jobs)
