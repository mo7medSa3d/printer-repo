# -*- coding: utf-8 -*-
"""Durable Odoo-side print outbox and retry state."""

import base64
import datetime
import json
import logging
import time
import uuid

import requests
from psycopg2 import IntegrityError

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


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
    # Canonical status vocabulary (mirrors the Gateway DB status enum
    # queued/claimed/printing/success/failed/expired in
    # src/lib/job-status.ts, plus Odoo-side 'submitted' for "accepted by the
    # Gateway, awaiting agent claim" and 'partial' as an operator-side
    # terminal state). Terminal: success/failed/partial/unknown - enforced
    # by _VALID_TRANSITIONS and write(). Physical outcome metadata is
    # exactly printed/not_printed/unknown (_compute_physical_outcome):
    # 'success' => printed; 'unknown'/'partial' => unknown; anything else
    # carrying a _GATEWAY_UNKNOWN_MARKERS prefix => unknown; otherwise
    # not_printed. action_sync_status maps a Gateway 'failed' whose error
    # starts with any _GATEWAY_UNKNOWN_MARKERS prefix to 'unknown'.
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
    # Full document bytes (rendered PDF/JPEG, native command streams).
    # Restricted to system administrators: the job list/form never displays
    # payload content, and every server-side reader (submit/sync/retry runs
    # elevated or as cron). Same-company internal users keep status/history
    # visibility without access to other documents' byte content.
    payload = fields.Text(required=True, copy=False, readonly=True, groups="base.group_system")
    payload_type = fields.Selection([
        ("pdf", "PDF Vector"),
        ("raster_jpeg", "JPEG Raster Banding"),
        ("raw_cmd", "Native Printer Command"),
    ], default="pdf", required=True, readonly=True)
    protocol = fields.Selection([
        ("raw", "Raw Text/Binary"),
        ("escpos", "ESC/POS"),
        ("zpl", "Zebra ZPL-II"),
        ("tspl", "TSC TSPL"),
    ], required=False, readonly=True)
    raw_payload = fields.Text(string="Native Command Payload", readonly=True, groups="base.group_system")
    printer_profile = fields.Text(string="Printer Hardware Profile", readonly=True)
    fallback_binding_id = fields.Many2one("print_gateway.binding", string="Failover Backup Binding", readonly=True)
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
        # Canonical happy path: queued -> submitted -> claimed -> printing
        # -> success, exactly one hop at a time. Forward progress NEVER
        # skips a stage (an idempotent replay observed beyond 'submitted' is
        # recorded hop-by-hop via _advance_status, so no writer needs a
        # shortcut). Failure/unknown are explicitly valid exits from any
        # non-terminal state; nothing leaves a terminal state (self-loops
        # only, and 'partial' accepts no inbound writes at all - the
        # Gateway sync never produces it).
        "queued": {"submitted", "failed", "unknown"},
        "submitted": {"claimed", "failed", "unknown"},
        "claimed": {"printing", "failed", "unknown"},
        "printing": {"success", "failed", "unknown"},
        "success": {"success"},
        "failed": {"failed"},
        "partial": {"partial"},
        "unknown": {"unknown"},
    }

    # Forward-progress chain for _advance_status. Failure/unknown are NOT
    # chain hops: they are written directly (they are valid exits from any
    # non-terminal state per the matrix above).
    _FORWARD_CHAIN = ("queued", "submitted", "claimed", "printing", "success")

    def _advance_status(self, job, target, values):
        """Write a status advance honoring the canonical chain.

        `values` carries the final row content (gateway_job_id, attempts,
        last_error, completed_at...); its "status" key is ignored in favor
        of `target`. Forward hops (e.g. queued -> claimed on an idempotent
        replay) are written stage-by-stage so the transition matrix never
        needs a shortcut; failure/unknown targets are written directly.
        Raises ValidationError for any regression or unknown target.
        """
        job.ensure_one()
        if target not in self._FORWARD_CHAIN and target not in ("failed", "unknown"):
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        if target == job.status:
            # Refresh-only write (e.g. a sync updating last_error while the
            # state is unchanged): write() skips the matrix on no-op
            # transitions, so this is always legal.
            refresh_values = dict(values)
            refresh_values["status"] = target
            job.write(refresh_values)
            return
        if target in ("failed", "unknown"):
            terminal_values = dict(values)
            terminal_values["status"] = target
            job.write(terminal_values)
            return
        try:
            position = self._FORWARD_CHAIN.index(job.status)
            destination = self._FORWARD_CHAIN.index(target)
        except ValueError:
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        if destination < position:
            raise ValidationError(
                _("Invalid print job state transition from '%s' to '%s'.")
                % (job.status, target)
            )
        for hop in self._FORWARD_CHAIN[position + 1:destination + 1]:
            hop_values = {"status": hop}
            if hop == target:
                hop_values.update({key: value for key, value in values.items() if key != "status"})
            job.write(hop_values)

    # Payload kinds recognized in the canonical contract. A payload whose
    # type is not one of these is malformed input and must fail - it is
    # never "repaired" into a PDF job.
    # Canonical wire types, EXACTLY mirroring the Gateway
    # (src/lib/payload.ts) and the Go agent
    # (agent/internal/payload/payload.go): raw, escpos, image, pdf.
    # "jpeg"/"raster_jpeg" are INTERNAL column names, never payload types -
    # the drift that accepted them here but failed at the Gateway 422 is
    # removed on purpose: a persisted job must always be submittable.
    _PAYLOAD_TYPE_MAP = {
        "raw": "raw_cmd",
        "escpos": "raw_cmd",
        "image": "raster_jpeg",
        "pdf": "pdf",
    }

    @api.model
    def _resolve_payload_kind(self, payload_json):
        """Parse a persisted payload string and resolve its declared kind.

        Strict by contract: unparseable JSON, a non-object, or an unknown
        ``type`` all raise. There is no silent default.
        """
        try:
            parsed = json.loads(payload_json) if isinstance(payload_json, str) else payload_json
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Print payload is not valid JSON: %s") % exc) from exc
        if not isinstance(parsed, dict):
            raise ValidationError(_("Print payload must be a JSON object."))
        ptype = str(parsed.get("type") or "").strip().lower()
        if ptype not in self._PAYLOAD_TYPE_MAP:
            raise ValidationError(
                _("Unsupported payload type '%s'. Expected one of: %s.")
                % (ptype or "(missing)", ", ".join(sorted(self._PAYLOAD_TYPE_MAP)))
            )
        return parsed, self._PAYLOAD_TYPE_MAP[ptype]

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            payload_json = vals.get("payload")
            if "payload_type" not in vals:
                if not payload_json:
                    raise ValidationError(_("A print job requires a payload."))
                parsed, resolved_type = self._resolve_payload_kind(payload_json)
                vals["payload_type"] = resolved_type
                if resolved_type == "raw_cmd":
                    # Protocol must be stated explicitly - by the payload,
                    # by the caller's vals, or not at all (which fails the
                    # constraint below). It is never inferred from the type.
                    if "protocol" not in vals or not vals.get("protocol"):
                        proto = parsed.get("protocol")
                        if not proto:
                            raise ValidationError(_(
                                "Native command payloads require an explicit protocol "
                                "(raw, escpos, zpl, or tspl); none was declared."
                            ))
                        vals["protocol"] = proto
                    payload_proto = parsed.get("protocol")
                    if payload_proto and payload_proto != vals["protocol"]:
                        raise ValidationError(_(
                            "Payload protocol '%s' contradicts job protocol '%s'."
                        ) % (payload_proto, vals["protocol"]))
                else:
                    vals["protocol"] = False
            elif vals.get("payload_type") in ("pdf", "raster_jpeg"):
                if payload_json:
                    _parsed, resolved_type = self._resolve_payload_kind(payload_json)
                    if resolved_type != vals["payload_type"]:
                        raise ValidationError(_(
                            "Payload content (type '%s') contradicts the declared "
                            "payload_type '%s'."
                        ) % (resolved_type, vals["payload_type"]))
                # Absent/False protocol is legal; an actual protocol on a
                # pdf/raster job is a contradiction and must fail, not be
                # silently stripped.
                if vals.get("protocol"):
                    raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
                vals["protocol"] = False
            elif vals.get("payload_type") == "raw_cmd":
                if payload_json:
                    parsed, resolved_type = self._resolve_payload_kind(payload_json)
                    if resolved_type != "raw_cmd":
                        raise ValidationError(_(
                            "Payload content (type '%s') contradicts the declared "
                            "payload_type 'raw_cmd'."
                        ) % resolved_type)
                    if not vals.get("protocol"):
                        raise ValidationError(_("Native command payloads require a valid printer protocol."))
        return super().create(vals_list)

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
        if "payload_type" in vals and vals["payload_type"] in ("pdf", "raster_jpeg") and vals.get("protocol"):
            raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
        if "payload" in vals and not vals.get("payload_type"):
            # A re-written payload must still resolve to a valid kind and,
            # for this row's payload_type, stay consistent with it.
            parsed, resolved_type = self._resolve_payload_kind(vals["payload"])
            for job in self:
                if job.payload_type and resolved_type != job.payload_type:
                    raise ValidationError(_(
                        "New payload content (type '%s') contradicts this job's "
                        "payload_type '%s'."
                    ) % (resolved_type, job.payload_type))
                if job.payload_type == "raw_cmd":
                    payload_proto = parsed.get("protocol")
                    if not payload_proto:
                        raise ValidationError(_("Native command payloads require an explicit protocol in the payload."))
                    if job.protocol and payload_proto != job.protocol:
                        raise ValidationError(_(
                            "Payload protocol '%s' contradicts job protocol '%s'."
                        ) % (payload_proto, job.protocol))
        if "payload_type" in vals and vals["payload_type"] in ("pdf", "raster_jpeg"):
            vals["protocol"] = False
        return super().write(vals)

    @api.constrains("payload_type", "protocol")
    def _check_payload_type_and_protocol(self):
        for job in self:
            if job.payload_type in ("pdf", "raster_jpeg"):
                if job.protocol:
                    raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
            elif job.payload_type == "raw_cmd":
                if not job.protocol:
                    raise ValidationError(_("Native command payloads require a valid printer protocol."))

    # Marker prefixes the Gateway uses to say "execution reached an
    # ambiguous physical boundary". These MUST stay in lockstep with
    # PHYSICAL_OUTCOME_UNKNOWN_MARKERS in src/lib/job-status.ts; the
    # contract test test_gateway_marker_parity asserts both lists match.
    _GATEWAY_UNKNOWN_MARKERS = (
        "AGENT_EXECUTION_TIMEOUT",
        "AGENT_RESTART_DURING_PRINT",
        "JOB_EXPIRED_DURING_PRINT",
        "UNKNOWN_PARTIAL_DELIVERY",
        "UNKNOWN_SUBMISSION_OUTCOME",
    )

    @api.depends("status", "last_error")
    def _compute_physical_outcome(self):
        for job in self:
            if job.status == "success":
                job.physical_outcome = "printed"
            elif job.status in ("unknown", "partial"):
                job.physical_outcome = "unknown"
            elif any(str(job.last_error or "").startswith(marker) for marker in self._GATEWAY_UNKNOWN_MARKERS):
                # A gateway "failed" carrying an unknown-outcome marker must
                # NEVER present as "definitely not printed" - that is what
                # would enable the safe-looking Retry button on a job whose
                # paper may already exist.
                job.physical_outcome = "unknown"
            else:
                job.physical_outcome = "not_printed"

    @api.private
    @api.model
    def create_operation(self, *, company, gateway_config, printer_id, destination, document_type,
                         payload, source_model=None, source_record_id=None, report=None,
                         idempotency_key=None, payload_type=None, protocol=None,
                         raw_payload=None, printer_profile=None, fallback_binding=None):
        # TRUSTED SERVICE BOUNDARY (not reachable via RPC):
        # print_gateway.print_job is intentionally read-only for normal users
        # (ACL: group_user has read only), yet the print flows run as those
        # users. Creation therefore runs with sudo INSIDE this method only,
        # AFTER the server-side scope/company/protocol validation above and
        # below. The ONLY legal producers are server-side router code paths
        # (report/POS/kitchen/intent/raw/test-page) and retry actions - all of
        # which validated the caller's authorization before delegating here.
        # Granting blanket create rights on the model instead would let any
        # user forge arbitrary outbox rows (printer/protocol/data of choice).
        self_su = self.sudo()
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
        # Phase 13 canonical peripheral representation: INACTIVE peripherals
        # are omitted entirely rather than serialized as "none" actions.
        if isinstance(payload, dict) and isinstance(payload.get("peripherals"), dict):
            active = {k: v for k, v in payload["peripherals"].items() if v and v != "none"}
            if active:
                payload = dict(payload, peripherals=active)
            else:
                payload = {k: v for k, v in payload.items() if k != "peripherals"}
        try:
            payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Print payload is not JSON serializable.")) from exc
        if len(payload_json.encode("utf-8")) > 8 * 1024 * 1024:
            raise ValidationError(_("Print payload exceeds the 8 MiB safety limit."))

        # Strict kind resolution with NO defaults: a malformed payload fails
        # HERE, at creation, exactly as it would before submission. Persisted
        # content is validated to the same standard as external API input.
        parsed_payload, derived_type = self._resolve_payload_kind(payload_json)

        if payload_type:
            if payload_type != derived_type:
                raise ValidationError(_(
                    "Payload content (type '%s') contradicts the declared payload_type '%s'."
                ) % (derived_type, payload_type))
        else:
            payload_type = derived_type

        if payload_type in ("pdf", "raster_jpeg"):
            if protocol:
                raise ValidationError(_("PDF and Raster payloads cannot specify a printer protocol."))
            effective_protocol = False
        else:
            payload_protocol = parsed_payload.get("protocol")
            if protocol and payload_protocol and protocol != payload_protocol:
                raise ValidationError(_(
                    "Protocol argument '%s' contradicts the payload's own protocol '%s'."
                ) % (protocol, payload_protocol))
            effective_protocol = protocol or payload_protocol
            if not effective_protocol:
                raise ValidationError(_(
                    "Native command payloads require an explicit printer protocol; "
                    "none was declared (protocol is never inferred from the payload type)."
                ))

        key = (idempotency_key or uuid.uuid4().hex).strip()

        def same_operation(existing):
            return (
                existing.printer_id == str(printer_id).strip()
                and existing.destination == str(destination).strip()
                and existing.document_type == str(document_type).strip().lower()
                and existing.payload == payload_json
            )

        existing = self_su.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
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
            "payload_type": payload_type,
            "protocol": effective_protocol,
            "raw_payload": (raw_payload.replace("\x00", "\\x00") if isinstance(raw_payload, str) else False),
            "printer_profile": printer_profile or False,
            "fallback_binding_id": fallback_binding.id if fallback_binding else False,
            "idempotency_key": key,
            "next_retry_at": fields.Datetime.now(),
            "source_model": source_model or False,
            "source_record_id": source_record_id or False,
            "report_id": report.id if report else False,
        }
        try:
            with self.env.cr.savepoint():
                job = self_su.create(values)
                # Creation performs the SAME strict persisted-payload
                # validation as submission: malformed content can never be
                # stored and dispatched later.
                job._validate_persisted_payload(json.loads(payload_json))
                return job
        except IntegrityError:
            existing = self_su.search([("company_id", "=", company.id), ("idempotency_key", "=", key)], limit=1)
            if existing:
                if not same_operation(existing):
                    raise ValidationError(_("The idempotency key is already used for a different print operation."))
                return existing
            raise

    def _persist_state(self, values):
        # Status/audit persistence for the submit path: runs elevated because
        # the submitter may be a normal print operator (see create_operation's
        # service-boundary note); the submitter's authorization was already
        # established when the durable job was created.
        self.ensure_one()
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            env["print_gateway.print_job"].sudo().browse(self.id).write(values)
            cr.commit()
        finally:
            cr.close()

    def _validate_persisted_payload(self, payload):
        self.ensure_one()
        if not isinstance(payload, dict):
            raise ValidationError(_("Stored print payload must be a dictionary."))
        ptype = payload.get("type")
        if not ptype:
            raise ValidationError(_("Stored print payload is missing 'type'."))
        encoding = payload.get("encoding")
        if encoding != "base64":
            raise ValidationError(_("Stored print payload must declare encoding 'base64', got '%s'.") % encoding)

        if self.payload_type == "pdf":
            if ptype != "pdf":
                raise ValidationError(_("Payload type mismatch: expected 'pdf', got '%s'.") % ptype)
            if payload.get("protocol"):
                raise ValidationError(_("PDF payloads cannot specify a printer protocol."))
        elif self.payload_type == "raster_jpeg":
            if ptype != "image":
                raise ValidationError(_("Payload type mismatch: expected 'image', got '%s'.") % ptype)
            if payload.get("protocol"):
                raise ValidationError(_("Raster payloads cannot specify a printer protocol."))
        elif self.payload_type == "raw_cmd":
            if ptype not in ("raw", "escpos"):
                raise ValidationError(_("Payload type mismatch: expected raw/escpos, got '%s'.") % ptype)
            payload_proto = payload.get("protocol")
            if not payload_proto:
                # The WIRE contract requires the protocol inside the payload
                # too; the column alone is not enough (the agent validates
                # the submitted JSON, not this row).
                raise ValidationError(_("Raw/escpos payloads must declare their protocol inside the payload."))
            if ptype == "escpos" and payload_proto != "escpos":
                raise ValidationError(_("ESC/POS payloads require protocol 'escpos', got '%s'.") % payload_proto)
            if payload_proto not in ("raw", "escpos", "zpl", "tspl"):
                raise ValidationError(_("Unsupported payload protocol '%s'.") % payload_proto)
            if self.protocol and payload_proto != self.protocol:
                raise ValidationError(
                    _("Payload protocol mismatch: expected '%s', got '%s'.")
                    % (self.protocol, payload_proto)
                )
        else:
            raise ValidationError(_("Unknown payload type column '%s'.") % self.payload_type)

        # The wire contract names this field "data" only. The old
        # "base64" alias is removed: a job submitting {"base64": ...} would
        # pass here and then 422 at the Gateway.
        raw_data = payload.get("data")
        if not raw_data or not isinstance(raw_data, str):
            raise ValidationError(_("Stored print payload data must be a non-empty string."))
        try:
            decoded = base64.b64decode(raw_data.encode("ascii"), validate=True)
            if not decoded:
                raise ValidationError(_("Stored print payload decoded to empty content."))
        except Exception as exc:
            raise ValidationError(_("Stored print payload data is not valid base64.")) from exc
        if len(decoded) > 8 * 1024 * 1024:
            raise ValidationError(_("Stored print payload exceeds the 8 MiB safety limit."))
        # Content/signature parity with the Gateway and agent validators:
        # what claims to be a PDF must start with %PDF-, a raster must be a
        # JPEG, and byte streams must not smuggle PDF headers.
        looks_like_pdf = decoded[:5] == b"%PDF-"
        looks_like_jpeg = len(decoded) >= 3 and decoded[0] == 0xFF and decoded[1] == 0xD8 and decoded[2] == 0xFF
        if self.payload_type == "pdf" and not looks_like_pdf:
            raise ValidationError(_("PDF payload must start with the %%PDF- signature."))
        if self.payload_type == "raster_jpeg" and not looks_like_jpeg:
            raise ValidationError(_("Raster payload must be a JPEG."))
        if self.payload_type == "raw_cmd" and looks_like_pdf:
            raise ValidationError(_("PDF bytes cannot be labeled as raw/escpos; the Gateway would reject this submission."))

        peripherals = payload.get("peripherals")
        if peripherals is not None:
            if not isinstance(peripherals, dict):
                raise ValidationError(_("Payload peripherals must be a dictionary."))
            active_periph = {
                k: v for k, v in peripherals.items()
                if v and v != "none"
            }
            if not active_periph:
                payload.pop("peripherals", None)
            else:
                is_escpos = ptype == "escpos" or (ptype == "raw" and (payload.get("protocol") == "escpos" or self.protocol == "escpos"))
                if not is_escpos:
                    raise ValidationError(_("Peripherals are only supported for ESC/POS protocol."))
                payload["peripherals"] = active_periph

    def _submission_body(self):
        self.ensure_one()
        try:
            payload = json.loads(self.payload)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("Stored print payload is corrupted.")) from exc
        self._validate_persisted_payload(payload)
        body = {
            "printerId": self.printer_id,
            "documentType": self.document_type,
            "destination": self.destination,
            "payload": payload,
            "idempotencyKey": self.idempotency_key,
        }
        return body

    def _post_source_audit(self, message):
        """Post audit message to source record chatter if supported."""
        for job in self:
            if not job.source_model or not job.source_record_id:
                continue
            try:
                record = self.env[job.source_model].browse(job.source_record_id).exists()
                if record and hasattr(record, "message_post"):
                    record.message_post(body=message, subtype_xmlid="mail.mt_note")
            except Exception as exc:
                _logger.debug("Chatter audit logging skipped: %s", exc)

    @api.model
    def _is_pre_dispatch_error(self, exc):
        """True ONLY when the exception chain proves the HTTP request never
        left this host (connect refused / DNS failure / connect timeout).

        requests wraps urllib3 errors whose meaning depends on the phase:
        NewConnectionError / ConnectTimeoutError / NameResolutionError are
        raised during connection establishment (zero bytes transmitted);
        ProtocolError / RemoteDisconnected / ReadTimeoutError /
        ConnectionResetError can all fire AFTER the request body reached the
        Gateway. We never guess: anything not provably connect-phase is an
        ambiguous dispatch, eligible for neither failover nor automatic
        retry - the durable idempotency key protects a deliberate replay.
        """
        seen = set()
        stack = [exc]
        while stack:
            current = stack.pop()
            if current is None or id(current) in seen:
                continue
            seen.add(id(current))
            name = type(current).__name__
            if name in (
                "ConnectionRefusedError",
                "gaierror",
                "NewConnectionError",
                "ConnectTimeoutError",
                "NameResolutionError",
            ):
                return True
            if name in (
                "ProtocolError",
                "ReadTimeoutError",
                "RemoteDisconnected",
                "ConnectionResetError",
                "BrokenPipeError",
                "TimeoutError",
                "SSLError",
                "CertificateError",
            ):
                return False
            stack.append(getattr(current, "__cause__", None))
            stack.append(getattr(current, "__context__", None))
            for arg in getattr(current, "args", ()):
                if isinstance(arg, BaseException):
                    stack.append(arg)
        return False

    @api.model
    def _is_deterministic_failure(self, exc):
        """True when retrying can NEVER succeed: validation/programming
        failures, not transport failures.

        - Odoo ValidationError: our own persisted payload failed strict
          validation (corrupted/stale row) - resubmitting identical bytes
          fails identically.
        - GATEWAY_INVALID_RESPONSE: the Gateway answered 200 with a body
          that violates its own contract (no job id / unparsable JSON) -
          a gateway-side bug, not a transport blip.
        - requests URL/config errors (MissingSchema/InvalidSchema/
          InvalidURL/InvalidHeader): broken Gateway configuration, not a
          network condition.

        Everything else (HTTP 5xx, chunked/stream errors, ambiguous
        timeouts) stays on the retry path: the durable idempotency key
        makes a replay safe.
        """
        if isinstance(exc, ValidationError):
            return True
        message = str(exc)[:120]
        if "GATEWAY_INVALID_RESPONSE" in message:
            return True
        return type(exc).__name__ in (
            "MissingSchema",
            "InvalidSchema",
            "InvalidURL",
            "InvalidHeader",
        )

    def _record_ambiguous_submission(self, job, exc, detail, raise_on_failure=False):
        """Terminalize a submission whose outcome cannot be proven.

        Used for post-dispatch timeouts AND for connection failures that are
        not provably connect-phase. No failover, no automatic retry: the job
        may already exist on the Gateway, and the durable idempotency key
        makes a deliberate operator replay safe instead of a silent duplicate.
        """
        values = {
            "status": "unknown",
            "attempts": job.attempts + 1,
            "last_error": "UNKNOWN_SUBMISSION_OUTCOME: %s (ambiguous dispatch)" % detail,
            "next_retry_at": False,
        }
        if raise_on_failure:
            job._persist_state(values)
        else:
            job.write(values)
        job._post_source_audit(_("WARNING: Print Job #%s submission outcome is unknown on '%s'.") % (job.id, job.printer_id))
        _logger.warning("Gateway submission outcome unknown for job %s: %s", job.idempotency_key[:8], detail)
        if raise_on_failure:
            raise ValidationError(_("Gateway submission outcome is unknown; physical outcome is ambiguous. Automated retries are paused to prevent duplicate prints. Operator reprint required.")) from exc

    def _handle_pre_dispatch_failure(self, job, exc, current_binding, visited_bindings, failover_count, raise_on_failure):
        """Retry/failover for failures PROVEN to precede any transmission.

        The caller must have established _is_pre_dispatch_error(exc) first.
        Returns (current_binding, failover_count, resume) where resume is
        "continue" (failover engaged: re-enter the submission loop with the
        backup printer) or "break" (job requeued/failed with backoff).

        Bounded depth and cycle visited-set prevent failover loops
        (A->B->C depth, A->B->A revisited target). Attempts still burn on
        repeated pre-dispatch failures so a dead Gateway cannot spin the
        cron forever.
        """
        MAX_FAILOVER_DEPTH = 3
        # Pre-dispatch failure: zero bytes transmitted. Safe failover check!
        if job.attempts == 0 and current_binding and failover_count < MAX_FAILOVER_DEPTH:
            next_printer = current_binding.printer_id
            binding_company = current_binding.branch_id or current_binding.company_id
            company_compatible = (
                binding_company == job.company_id
                or (not current_binding.branch_id and current_binding.company_id == (job.company_id.parent_id or job.company_id))
            )
            # Phase 11: failover requires EXACT protocol/capability
            # parity - never a broadened match to "make failover work".
            fallback_proto = getattr(current_binding, "printer_protocol", False) or ""
            if job.payload_type == "pdf":
                protocol_compatible = fallback_proto in ("spooler", "ipp", "ipps")
            elif job.payload_type == "raster_jpeg":
                protocol_compatible = fallback_proto in ("spooler", "escpos")
            elif job.payload_type == "raw_cmd" and job.protocol:
                protocol_compatible = fallback_proto == job.protocol
            else:
                protocol_compatible = False
            if (
                current_binding.enabled
                and next_printer
                and next_printer not in visited_bindings
                and company_compatible
                and protocol_compatible
            ):
                visited_bindings.add(next_printer)
                failover_count += 1
                _logger.warning(
                    "Primary printer %s connection failed; triggering safe pre-dispatch failover (%d/%d) to %s",
                    job.printer_id, failover_count, MAX_FAILOVER_DEPTH, next_printer,
                )
                job.write({
                    "printer_id": next_printer,
                    "destination": current_binding.destination_ref.display_name if current_binding.destination_ref else current_binding.name,
                    "last_error": "PRE_DISPATCH_FAILOVER: Routed to backup printer %s" % next_printer,
                })
                job._post_source_audit(_("Primary printer offline. Failover engaged: routed to backup printer '%s'") % next_printer)
                current_binding = current_binding.fallback_binding_id
                return current_binding, failover_count, "continue"

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
        return current_binding, failover_count, "break"

    def _require_outbox_write(self):
        # The durable outbox is read-only for normal users; status-changing
        # operator actions are privileged. Server-side flows (router submit,
        # intent dispatch, cron) already run elevated and pass transparently.
        # This guard keeps RPC access fail-closed for interactive users.
        # NOTE: check_access() is the single Odoo 19 API covering both model
        # rights and record rules (check_access_rights/check_access_rule are
        # deprecated since 18.0).
        self.check_access("write")

    def action_submit(self, raise_on_failure=False):
        self._require_outbox_write()
        return self._action_submit_trusted(raise_on_failure=raise_on_failure)

    @api.private
    def _action_submit_trusted(self, raise_on_failure=False):
        """Trusted internal submission (not reachable via RPC).

        Runs the full submit flow elevated: the durable outbox is
        intentionally read-only for normal users (group_user has no write
        right), yet every legitimate print flow - report download, POS,
        intents, retry - executes as the print operator. The router
        (print_router._submit_durable_job) is the only production caller and
        delegates here AFTER resolving and validating company/branch/binding/
        printer scope. Interactive/admin callers keep using the guarded
        public action_submit(); cron already runs elevated.
        """
        # Elevate for the whole flow. Re-applied after with_company below:
        # with_company() rebuilds the environment and must never be allowed
        # to silently drop the trusted context on any Odoo version.
        self = self.sudo()
        MAX_FAILOVER_DEPTH = 3
        for job in self:
            # Terminal is terminal, with OR without a remote id: a job that
            # failed before ever receiving a gateway id must not be silently
            # re-submitted (attempts, state and audit would be rewritten).
            # Only an explicit operator reprint creates a NEW operation.
            if job.status in self._TERMINAL:
                continue

            current_binding = job.fallback_binding_id
            visited_bindings = {job.printer_id}
            failover_count = 0

            while True:
                gateway_config = job.gateway_config_id.sudo()
                try:
                    response = requests.post(
                        "%s/api/print/jobs" % gateway_config._gateway_base(for_request=True),
                        json=job._submission_body(), headers=gateway_config._gateway_headers(),
                        timeout=(5, 20), allow_redirects=False,
                    )
                    if response.status_code not in (200, 201):
                        # Deterministic client-side rejections (invalid
                        # payload semantics, capability mismatch, idempotency
                        # conflict, forbidden document type) will never
                        # succeed on retry. Terminalize immediately with the
                        # Gateway's (safe, typed) reason instead of burning
                        # the exponential-backoff budget.
                        if response.status_code in (400, 403, 404, 409, 422):
                            try:
                                reason = str(response.json().get("error") or "")[:2000] or "GATEWAY_REJECTED"
                            except ValueError:
                                reason = "GATEWAY_HTTP_%s" % response.status_code
                            terminal_error = "GATEWAY_REJECTED_%s: %s" % (response.status_code, reason)
                            values = {
                                "status": "failed",
                                "attempts": job.attempts + 1,
                                "last_error": terminal_error,
                                "next_retry_at": False,
                                "completed_at": fields.Datetime.now(),
                            }
                            if raise_on_failure:
                                job._persist_state(values)
                            else:
                                job.write(values)
                            _logger.warning("Gateway rejected job %s deterministically (%s): %s", job.idempotency_key[:8], response.status_code, reason[:300])
                            if raise_on_failure:
                                raise ValidationError(_("The Gateway rejected this print job: %s") % reason[:500])
                            break
                        raise RuntimeError("GATEWAY_HTTP_%s" % response.status_code)
                    body = response.json()
                    remote_id = body.get("jobId") or body.get("id")
                    if not remote_id:
                        raise RuntimeError("GATEWAY_INVALID_RESPONSE")
                    remote_status = str(body.get("status") or "queued").strip().lower()
                    remote_error = body.get("error")
                    if remote_status == "completed":
                        remote_status = "success"
                    if remote_status == "expired":
                        # The Gateway terminalized the job (its lease window
                        # elapsed). Mirror the physical outcome honestly.
                        expired_error = remote_error or "GATEWAY_JOB_EXPIRED: the Gateway release window elapsed before the job was claimed"
                        expired_status = "unknown" if str(expired_error).startswith(job._GATEWAY_UNKNOWN_MARKERS) or "JOB_EXPIRED_DURING_PRINT" in str(expired_error) else "failed"
                        job.write({
                            "gateway_job_id": str(remote_id),
                            "status": expired_status,
                            "attempts": job.attempts + 1,
                            "last_error": expired_error,
                            "next_retry_at": False,
                            "completed_at": fields.Datetime.now(),
                        })
                        job._post_source_audit(_("Print Job #%s expired at the Gateway (%s).") % (remote_id or job.id, expired_status))
                        break
                    if remote_status not in {"queued", "submitted", "claimed", "printing", "success", "failed", "unknown"}:
                        remote_status = "submitted"
                    values = {
                        "gateway_job_id": str(remote_id),
                        "attempts": job.attempts + 1, "last_error": False, "next_retry_at": False,
                    }
                    if remote_status == "failed" and remote_error:
                        values["last_error"] = str(remote_error)[:4000]
                    # An idempotent replay may report the job beyond
                    # 'submitted' (claimed/printing/success at the Gateway).
                    # Record it hop-by-hop through the canonical chain rather
                    # than jumping queued -> success in one privileged write.
                    self._advance_status(job, "submitted" if remote_status == "queued" else remote_status, values)
                    job._post_source_audit(_("Print Job #%s queued to Gateway for '%s'") % (remote_id or job.id, job.printer_id))
                    break  # Success
                except requests.exceptions.Timeout as exc:
                    if self._is_pre_dispatch_error(exc):
                        # Connect-phase timeout only: the request provably
                        # never left this host - same retry/failover path as
                        # a refused connection. A read/ambiguous timeout
                        # stays terminal-unknown below.
                        current_binding, failover_count, resume = self._handle_pre_dispatch_failure(
                            job, exc, current_binding, visited_bindings, failover_count, raise_on_failure)
                        if resume == "continue":
                            continue
                        break
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
                    job._post_source_audit(_("WARNING: Print Job #%s timed out; physical outcome is unknown on '%s'.") % (job.id, job.printer_id))
                    _logger.warning("Gateway submission timed out; outcome is unknown for job %s", job.idempotency_key[:8])
                    if raise_on_failure:
                        raise ValidationError(_("Gateway submission timed out; physical outcome is unknown. Automated retries are paused to prevent duplicate prints. Operator reprint required.")) from exc
                    break
                except requests.exceptions.ConnectionError as exc:
                    if not self._is_pre_dispatch_error(exc):
                        # urllib3's ConnectionError also wraps mid-stream
                        # failures (reset/abort AFTER request bytes were
                        # sent). Without connect-phase proof the Gateway may
                        # already hold this job: no failover (that would
                        # create a second print) and no automatic retry.
                        self._record_ambiguous_submission(
                            job, exc,
                            "connection broke after the request may have been transmitted",
                            raise_on_failure)
                        break
                    current_binding, failover_count, resume = self._handle_pre_dispatch_failure(
                        job, exc, current_binding, visited_bindings, failover_count, raise_on_failure)
                    if resume == "continue":
                        continue
                    break
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
                    break
                except (ValueError, RuntimeError, ValidationError) as exc:
                    if self._is_deterministic_failure(exc):
                        # Programming/validation failures (corrupted
                        # persisted payload, gateway contract violation,
                        # broken gateway URL) can never succeed on retry:
                        # terminalize immediately instead of burning five
                        # backoff attempts on identical bytes.
                        values = {
                            "status": "failed", "attempts": job.attempts + 1,
                            "last_error": str(exc)[:4000],
                            "next_retry_at": False,
                            "completed_at": fields.Datetime.now(),
                        }
                        if raise_on_failure:
                            job._persist_state(values)
                        else:
                            job.write(values)
                        _logger.warning("Gateway submission failed deterministically for job %s: %s", job.idempotency_key[:8], str(exc)[:300])
                        if raise_on_failure:
                            raise ValidationError(_("Gateway submission failed: %s") % str(exc)[:500]) from exc
                        break
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
                    break
        return True

    def action_sync_status(self):
        self._require_outbox_write()
        candidates = self.filtered(lambda row: row.gateway_job_id and row.status not in self._TERMINAL)
        if not candidates:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Status Sync"),
                    "message": _("No active in-flight print jobs found to synchronize."),
                    "type": "info",
                    "sticky": False,
                },
            }
        synced_count = 0
        failed_count = 0
        for job in candidates:
            gateway_config = job.gateway_config_id.sudo()
            try:
                response = requests.get(
                    "%s/api/print/jobs" % gateway_config._gateway_base(for_request=True),
                    params={"id": job.gateway_job_id}, headers=gateway_config._gateway_headers(),
                    timeout=(5, 10), allow_redirects=False,
                )
                if response.status_code == 404:
                    # The Gateway no longer knows this job (release window
                    # elapsed / cleanup ran). Its physical outcome can no
                    # longer be proven from either side: terminalize as
                    # unknown so no automatic path can reprint it silently.
                    job.write({
                        "status": "unknown",
                        "last_error": "GATEWAY_JOB_NOT_FOUND: the Gateway no longer has this job (expired or cleaned up). Physical outcome unknown - verify at the printer, then use Force Reprint if needed.",
                        "next_retry_at": False,
                        "completed_at": fields.Datetime.now(),
                    })
                    job._post_source_audit(_("Print Job #%s is no longer known to the Gateway; outcome marked UNKNOWN for manual reconciliation.") % (job.gateway_job_id or job.id))
                    failed_count += 1
                    continue
                response.raise_for_status()
                body = response.json()
                status = str(body.get("status") or "").strip().lower()
                if status in ("completed", "success"):
                    status = "success"
                elif status == "queued":
                    # The canonical Gateway pre-dispatch state. It is the
                    # same fact as our "submitted": queued for pickup.
                    status = "submitted"
                elif status == "expired":
                    gateway_error = str(body.get("error") or "")
                    if gateway_error.startswith("JOB_EXPIRED_DURING_PRINT") or gateway_error.startswith("UNKNOWN_PARTIAL_DELIVERY"):
                        status = "unknown"
                        body.setdefault("error", "JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)")
                    else:
                        status = "failed"
                        if not body.get("error"):
                            body["error"] = "GATEWAY_JOB_EXPIRED: The Gateway no longer holds the job (never claimed within its release window); nothing reached the agent"
                if status not in {"submitted", "claimed", "printing", "success", "failed", "unknown"}:
                    # The Gateway contract only ever emits these six (its own
                    # CHECK-backed enum); anything else - including a "partial"
                    # the Gateway cannot produce - is rejected without
                    # touching the row.
                    failed_count += 1
                    continue
                err_msg = body.get("error") or False
                if status == "failed" and any(
                    str(err_msg or "").startswith(marker) for marker in self._GATEWAY_UNKNOWN_MARKERS
                ):
                    # Canonical rule: a Gateway FAILED carrying any
                    # UNKNOWN_* outcome marker lands in 'unknown' - never
                    # 'failed' (which would read as "definitely not printed"
                    # and wrongly offer ordinary Retry) and never a silent
                    # pass-through. The physical outcome is ambiguous until
                    # an operator verifies the printer; only Force Reprint
                    # may re-issue it. ('partial' stays a legal terminal
                    # state for operator-side use but the Gateway sync never
                    # produces it: every ambiguous Gateway outcome is
                    # 'unknown'.)
                    status = "unknown"
                values = {"last_error": err_msg}
                if status in self._TERMINAL:
                    values["completed_at"] = fields.Datetime.now()
                if status == "submitted" and job.status in ("claimed", "printing"):
                    # The Gateway requeued a job we already observed further
                    # along (stale-claim reclaim, evidence-push failure
                    # release, or fenced pre-execution rejection - all normal
                    # Gateway lease events, most visibly after the 90s stale
                    # window). Our row is AHEAD of the Gateway: there is no
                    # new information here. Writing 'submitted' would be a
                    # backward transition the matrix forbids - and raising
                    # would abort this whole sync loop (starving every other
                    # job, every minute, until the row converges). Keep our
                    # state; the next sync converges once the agent
                    # re-claims the job or its TTL expires it terminally
                    # (both transitions are forward and legal).
                    synced_count += 1
                    continue
                # Recorded hop-by-hop through the canonical chain: a sync
                # observing e.g. submitted -> success writes submitted ->
                # claimed -> printing -> success rather than jumping, so the
                # transition matrix needs no privileged shortcut.
                self._advance_status(job, status, values)
                synced_count += 1
                if status == "success":
                    job._post_source_audit(_("Print Job #%s completed by Gateway agent on '%s'") % (job.gateway_job_id or job.id, job.printer_id))
                elif status in ("partial", "unknown"):
                    job._post_source_audit(_("WARNING: Print Job #%s interrupted or ambiguous on '%s'. Manual check required.") % (job.gateway_job_id or job.id, job.printer_id))
            except (requests.RequestException, ValueError):
                failed_count += 1
                _logger.warning("Gateway status sync failed for job %s", job.idempotency_key[:8])

        if synced_count > 0 and failed_count == 0:
            notif_type = "success"
            msg = _("%d print job(s) synchronized successfully.") % synced_count
        elif synced_count > 0 and failed_count > 0:
            notif_type = "warning"
            msg = _("%d print job(s) synchronized, %d failed.") % (synced_count, failed_count)
        else:
            notif_type = "danger"
            msg = _("Status synchronization failed for all %d job(s).") % failed_count

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Status Synchronized"),
                "message": msg,
                "type": notif_type,
                "sticky": False,
            },
        }

    def action_retry(self):
        self._require_outbox_write()
        """Create a new logical print operation only from a definitely failed job.

        Unknown physical outcomes are never retried from the UI. A failed job that
        is definitely not printed gets a fresh idempotency key so the new operation
        is not collapsed into the old Gateway job.
        """
        failed_jobs = self.filtered(lambda row: row.status == "failed" and row.physical_outcome == "not_printed")
        if not failed_jobs:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("No Eligible Jobs"),
                    "message": _("No eligible failed print jobs (with confirmed non-printed outcome) found to retry."),
                    "type": "warning",
                    "sticky": False,
                },
            }
        retried_jobs = self.env["print_gateway.print_job"]
        for job in failed_jobs:
            retry = self.create_operation(
                company=job.company_id,
                gateway_config=job.gateway_config_id,
                printer_id=job.printer_id,
                destination=job.destination,
                document_type=job.document_type,
                payload=json.loads(job.payload),
                payload_type=job.payload_type,
                protocol=job.protocol,
                raw_payload=job.raw_payload,
                printer_profile=job.printer_profile,
                fallback_binding=job.fallback_binding_id,
                source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=uuid.uuid4().hex,
            )
            retry.action_submit()
            retried_jobs |= retry
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Print Job Retried"),
                "message": _("Retried %d print job(s) with new operation ID(s): %s")
                % (len(retried_jobs), ", ".join(str(j.id) for j in retried_jobs)),
                "type": "success",
                "sticky": False,
            },
        }

    def action_force_reprint(self):
        self._require_outbox_write()
        """Explicitly re-issue print operation for jobs with partial delivery or unknown physical outcome.

        This requires conscious operator action, preventing automated double printing of receipts/invoices.
        Generates a deterministic derived idempotency key: ${original_key}-reprint-${reprint_attempt_count}.
        """
        reprint_candidates = self.filtered(lambda row: row.status in ("partial", "unknown") or row.physical_outcome == "unknown")
        if not reprint_candidates:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("No Eligible Jobs"),
                    "message": _("No eligible partial or unknown outcome print jobs found for force reprint."),
                    "type": "info",
                    "sticky": False,
                },
            }
        reprinted_jobs = self.env["print_gateway.print_job"]
        for job in reprint_candidates:
            new_count = (job.reprint_attempt_count or 0) + 1
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
                payload_type=job.payload_type,
                protocol=job.protocol,
                raw_payload=job.raw_payload,
                printer_profile=job.printer_profile,
                fallback_binding=job.fallback_binding_id,
                source_model=job.source_model,
                source_record_id=job.source_record_id,
                report=job.report_id,
                idempotency_key=derived_key,
            )
            # The sequence number is consumed ONLY once the new operation
            # exists: a failed creation (validation/conflict) must not burn
            # a number, or the next attempt would skip a key and gap the
            # audit trail. Concurrent operators computing the same number
            # collapse onto the unique idempotency key instead of printing
            # twice.
            job.write({"reprint_attempt_count": new_count})
            retry.action_submit()
            reprinted_jobs |= retry
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Force Reprint Dispatched"),
                "message": _("Operator force reprint dispatched for %d job(s).") % len(reprinted_jobs),
                "type": "warning",
                "sticky": False,
            },
        }

    def _require_cron_runner(self):
        # Scheduled actions run under an administrator account; interactive
        # RPC callers must not be able to trigger bulk submission/sync waves
        # (each wave performs outbound HTTP to the Gateway). Fail closed
        # before any search or dispatch happens.
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only scheduled actions (administrator) may run this method."))

    @api.model
    @api.private
    def cron_submit_pending(self):
        self._require_cron_runner()
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
    @api.private
    def cron_sync_status(self):
        self._require_cron_runner()
        jobs = self.search([
            ("gateway_job_id", "!=", False),
            ("status", "not in", list(self._TERMINAL)),
        ], order="id asc", limit=100)
        for job in jobs:
            job.action_sync_status()
        return len(jobs)
