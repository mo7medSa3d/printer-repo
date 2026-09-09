# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for Gateway-enabled printing."""

import base64
import binascii
import hashlib
import uuid

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError

REPORT_DOCUMENT_TYPES = {
    "sale.order": "order",
    "account.move": "invoice",
    "stock.picking": "delivery",
    "purchase.order": "purchase_order",
    "pos.order": "receipt",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def _zpl_text(value):
    """Sanitize free text for a ZPL ^FD field: strip command introducers
    (^, ~) and C0 controls so company/printer names cannot inject additional
    ZPL commands into the diagnostic stream."""
    text = str(value or "")
    return "".join(ch for ch in text if ch not in "^~" and (ch >= " " or ch in "\n\t")).strip()[:80]


def _tspl_text(value):
    """Sanitize free text for a TSPL quoted TEXT argument: strip quotes and
    C0 controls so names cannot terminate the argument early."""
    text = str(value or "")
    return "".join(ch for ch in text if ch != '"' and (ch >= " " or ch in "\n\t")).strip()[:80]


def _escpos_text(value):
    """Sanitize free text for ESC/POS diagnostic tickets: the ticket builder
    injects its own control bytes, so user content must carry none."""
    text = str(value or "")
    return "".join(ch for ch in text if ch >= " ").strip()[:80]


class PrintGatewayRouter(models.AbstractModel):
    _name = "print_gateway.print_router"
    _description = "Print Gateway Central Router"

    @api.model
    def _binding_scope(self, company=None):
        """Return (Odoo company owning the Gateway config, branch context)."""
        company = company or self.env.company
        branch = company if company.parent_id else False
        gateway_company = company.parent_id if branch else company
        return gateway_company, branch

    @api.model
    def _gateway_config(self, company):
        gateway_company, _branch = self._binding_scope(company)
        config = self.env["print_gateway.gateway_config"].sudo().search(
            [("company_id", "=", gateway_company.id)], limit=1,
        )
        return config if config and config.enabled else False

    @api.model
    def _assert_current_company(self, company, record=None):
        current = self.env.company
        if not company or company != current:
            raise ValidationError(
                _("Print routing must use the active Odoo company/branch (%s).") % current.display_name
            )
        if record and getattr(record, "company_id", False) and record.company_id != current:
            raise ValidationError(
                _("The printable document belongs to %s, but the active Odoo company/branch is %s.")
                % (record.company_id.display_name, current.display_name)
            )
        return current

    @api.model
    def _document_type(self, report=None, record=None, explicit=None):
        value = explicit or self.env.context.get("print_gateway_document_type")
        if value:
            normalized = str(value).strip().lower()
            if normalized:
                return normalized
        model = record._name if record else report.model if report else ""
        if model in REPORT_DOCUMENT_TYPES:
            return REPORT_DOCUMENT_TYPES[model]
        if report:
            technical = (report.report_name or "").strip().lower()
            if technical:
                return "report:%s" % technical
        raise ValidationError(_("Print document type cannot be determined for this print action."))

    @api.model
    def destination_for(self, *, report=None, record=None, explicit_destination=None):
        return self.env["print_gateway.binding"].destination_for(
            record=record,
            report=report,
            explicit_destination=explicit_destination,
        )

    @api.model
    def resolve_binding(self, *, report=None, record=None, document_type=None, company=None, explicit_destination=None):
        current_company = self.env.company
        requested_company = company or current_company
        self._assert_current_company(requested_company, record=record)
        gateway_company, branch = self._binding_scope(current_company)
        config = self._gateway_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}
        dtype = self._document_type(report=report, record=record, explicit=document_type)
        destination = self.destination_for(
            report=report,
            record=record,
            explicit_destination=explicit_destination,
        )
        binding = self.env["print_gateway.binding"].sudo().find_for(
            gateway_company,
            dtype,
            report=report,
            record=record,
            explicit_destination=explicit_destination,
            branch=branch,
        )
        if not binding:
            raise ValidationError(
                _("Gateway printing is enabled, but no Print Binding exists for %s (%s) in %s.")
                % (destination.display_name, dtype, branch.display_name if branch else gateway_company.display_name)
            )
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "binding_id": binding.id if binding else False,
            "printer_id": binding.printer_id if binding else False,
            "runtime_agent_id": binding.runtime_agent_id if binding else False,
            "document_type": dtype,
            "destination": destination,
            "company": gateway_company,
            "branch": branch,
        }

    @staticmethod
    def _validate_pdf(pdf_content, report):
        if isinstance(pdf_content, (list, tuple)):
            pdf_content = pdf_content[0] if pdf_content else b""
        if not pdf_content or not bytes(pdf_content).startswith(b"%PDF-"):
            raise ValidationError(_("The rendered report %s is not a valid PDF.") % report.display_name)
        return bytes(pdf_content)

    @staticmethod
    def _validate_jpeg_base64(image):
        if not isinstance(image, str) or not image:
            raise ValidationError(_("The POS print image is missing."))
        try:
            data = base64.b64decode(image, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValidationError(_("The POS print image is not valid base64.")) from exc
        if not data or len(data) > MAX_IMAGE_BYTES or not data.startswith(b"\xff\xd8\xff"):
            raise ValidationError(_("The POS print image is not a valid JPEG or exceeds the 5 MiB safety limit."))
        return image

    @api.model
    def _render_pdf_payload(self, report, records, data=None):
        report.ensure_one()
        records = records.exists()
        if not records:
            raise ValidationError(_("Cannot print an empty report."))
        try:
            pdf_content, _ = report._render_qweb_pdf(report, res_ids=records.ids, data=data)
        except Exception as exc:
            raise ValidationError(_("Failed to render %s for Gateway printing.") % report.display_name) from exc
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(self._validate_pdf(pdf_content, report)).decode("ascii"),
        }

    @api.model
    def _render_pdf_payload_from_target(self, report_ref, render_target, *, context_values=None):
        try:
            renderer = self.env["ir.actions.report"].with_context(**(context_values or {}))
            pdf_content, _ = renderer._render_qweb_pdf(report_ref, render_target)
        except Exception as exc:
            report = self.env.ref(report_ref, raise_if_not_found=False)
            label = report.display_name if report else report_ref
            raise ValidationError(_("Failed to render %s for Gateway printing.") % label) from exc
        report = self.env.ref(report_ref, raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The requested report is unavailable."))
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(self._validate_pdf(pdf_content, report)).decode("ascii"),
        }

    @api.model
    def _persist_durable_job(self, values):
        """Create the durable Odoo outbox row in an independent transaction."""
        durable_values = dict(values)
        for key in ("company", "gateway_config", "report", "fallback_binding"):
            record = durable_values.get(key)
            durable_values[key] = record.id if record else False

        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            for key, model_name in (
                ("company", "res.company"),
                ("gateway_config", "print_gateway.gateway_config"),
                ("report", "ir.actions.report"),
                ("fallback_binding", "print_gateway.binding"),
            ):
                record_id = durable_values.get(key)
                if not record_id:
                    durable_values[key] = False
                    continue
                # Elevated re-fetch: authorization for company/config/binding/
                # report was already established by resolve_binding in the
                # caller's context; this only proves the rows still exist.
                # Requiring the operator's raw rights here as well would
                # spuriously fail legitimate prints (e.g. a branch operator
                # printing through a root-company Gateway config), and the
                # create_operation service boundary performs its own checks.
                record = env[model_name].sudo().browse(record_id).exists()
                if not record:
                    raise ValidationError(_("The durable print operation references a record that is no longer available."))
                durable_values[key] = record
            target_company = durable_values.get("company")
            model = env["print_gateway.print_job"]
            if target_company:
                model = model.with_company(target_company)
            job = model.create_operation(**durable_values)
            job_id = job.id
            cr.commit()
        finally:
            cr.close()
        return job_id

    @api.model
    def _submit_durable_job(self, job_id):
        """Submit a durable job using a fresh PostgreSQL transaction."""
        cr = self.env.registry.cursor()
        try:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            job = env["print_gateway.print_job"].browse(job_id).exists()
            if not job:
                raise ValidationError(_("The durable print job is no longer available."))
            try:
                job = job.with_company(job.company_id)
                job.action_submit(raise_on_failure=True)
                status = job.status
                cr.commit()
                return status
            except Exception:
                cr.rollback()
                raise
        finally:
            cr.close()

    def _submit_route(
        self, *, route, payload, company, report=None, source_model=None,
        source_record_id=None, idempotency_key=None,
    ):
        self._assert_current_company(company)
        binding = route.get("binding")
        if binding and isinstance(payload, dict):
            ptype = str(payload.get("type") or "").strip().lower()
            proto = str(payload.get("protocol") or "").strip().lower()
            is_escpos = ptype == "escpos" or (ptype == "raw" and proto == "escpos")
            if is_escpos:
                periph = binding.get_peripheral_payload()
                if periph:
                    payload["peripherals"] = periph
                else:
                    payload.pop("peripherals", None)
            else:
                payload.pop("peripherals", None)
        job_id = self._persist_durable_job({
            "company": company,

            "gateway_config": route["config"],
            "printer_id": route["binding"].printer_id,
            "destination": route["destination"].display_name,
            "document_type": route["document_type"],
            "payload": payload,
            "source_model": source_model,
            "source_record_id": source_record_id,
            "report": report,
            "fallback_binding": route["binding"].fallback_binding_id if route.get("binding") else None,
            "idempotency_key": idempotency_key or uuid.uuid4().hex,
        })
        status = self._submit_durable_job(job_id)
        return {
            "gateway_enabled": True,
            "native": False,
            "status": status,
            "job_id": job_id,
            "message": _("Print job %s accepted by the Gateway.") % job_id,
        }

    @api.model
    def route_report(self, report, records, data=None):
        report.ensure_one()
        records = records.exists()
        if not records:
            if self._gateway_config(self.env.company):
                raise ValidationError(_("Gateway printing requires at least one report record."))
            return {"gateway_enabled": False, "native": True}
        route = self.resolve_binding(report=report, record=records[0], company=self.env.company)
        if route.get("native"):
            return route
        for record in records[1:]:
            if hasattr(record, "company_id") and record.company_id and record.company_id != self.env.company:
                raise ValidationError(_("Selected records belong to conflicting routing scopes."))
            candidate = self.resolve_binding(report=report, record=record, company=self.env.company)
            if candidate["binding"].id != route["binding"].id:
                raise ValidationError(_("The selected records resolve to different Print Bindings. Print them separately."))
        return self._submit_route(
            route=route,
            payload=self._render_pdf_payload(report, records, data=data),
            company=self.env.company,
            report=report,
            source_model=records[0]._name,
            source_record_id=records[0].id,
        )

    @api.model
    def route_render_target(
        self, report_ref, render_target, *, company=None, document_type=None,
        explicit_destination=None, context_values=None,
    ):
        report = self.env.ref(report_ref, raise_if_not_found=False) if isinstance(report_ref, str) else report_ref
        if not report:
            raise ValidationError(_("The requested report is unavailable."))
        report.ensure_one()
        company = company or self.env.company
        self._assert_current_company(company)
        route = self.resolve_binding(
            report=report, document_type=document_type, company=company,
            explicit_destination=explicit_destination,
        )
        if route.get("native"):
            return route
        payload = self._render_pdf_payload_from_target(
            report.get_external_id().get(report.id, report.report_name),
            render_target,
            context_values=context_values,
        )
        return self._submit_route(route=route, payload=payload, company=company, report=report, source_model=report.model)

    @api.model
    def route_pos_receipt(self, order, image_base64):
        order.ensure_one()
        self._assert_current_company(order.company_id, record=order)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(record=order, company=self.env.company, document_type="receipt")
        if route.get("native"):
            return route
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company, source_model=order._name, source_record_id=order.id,
        )

    @api.model
    def route_kitchen_print(self, order, native_printer, image_base64, *, reprint=False, idempotency_key=None):
        order.ensure_one()
        native_printer.ensure_one()
        self._assert_current_company(order.company_id, record=order)
        company = self.env.company
        if native_printer.company_id != company:
            raise ValidationError(_("Kitchen printer belongs to another Odoo company."))
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(
            record=order, company=company, document_type="kitchen", explicit_destination=native_printer,
        )
        if route.get("native"):
            return route
        stable_key = "%s:%s" % (idempotency_key or uuid.uuid4().hex, native_printer.id)
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=company, source_model=order._name, source_record_id=order.id, idempotency_key=stable_key,
        )

    @api.model
    def route_pos_sale_details(self, session, image_base64):
        session.ensure_one()
        self._assert_current_company(session.company_id, record=session)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(
            company=self.env.company,
            document_type="report:point_of_sale.sale_details_report",
            explicit_destination=session.config_id,
        )
        if route.get("native"):
            return route
        return self._submit_route(
            route=route, payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company, source_model=session._name, source_record_id=session.id,
        )

    @api.model
    def route_intent(self, intent, record=None):
        """Route an automated print policy intent to the Outbox."""
        policy = intent.policy_id
        target_record = record or self.env[intent.res_model].browse(intent.res_id).exists()
        if not target_record:
            return {"status": "skipped", "message": _("Source record no longer exists.")}

        company = target_record.company_id if hasattr(target_record, "company_id") and target_record.company_id else self.env.company
        config = self._gateway_config(company)
        if not config:
            return {"status": "skipped", "message": _("Gateway printing is not enabled for company %s") % company.display_name}

        # Action type authority: check action_type explicitly
        if policy.action_type == "report":
            if not policy.report_id:
                raise ValidationError(_("Policy '%s' is configured for report action but has no report selected.") % policy.name)
            route = self.resolve_binding(
                report=policy.report_id,
                record=target_record,
                company=company,
                explicit_destination=policy.binding_id.destination_ref if policy.binding_id else None,
            )
            if route.get("native"):
                return {"status": "skipped", "message": _("Policy resolved to native print.")}
            res = self._submit_route(
                route=route,
                payload=self._render_pdf_payload(policy.report_id, target_record),
                company=company,
                report=policy.report_id,
                source_model=target_record._name,
                source_record_id=target_record.id,
                idempotency_key=intent.intent_key,
            )
            return {
                "status": "dispatched",
                "job_id": res.get("job_id"),
                "message": res.get("message"),
            }

        elif policy.action_type == "raw_template":
            if not policy.raw_protocol:
                raise ValidationError(_("Policy '%s' raw protocol is required.") % policy.name)
            raw_data = policy.render_raw_template(target_record)
            res = self.route_raw_command(
                raw_data,
                protocol=policy.raw_protocol,
                binding=policy.binding_id or False,
                record=target_record,
                company=company,
                document_type="label",
                idempotency_key=intent.intent_key,
            )
            if res.get("native"):
                return {"status": "skipped", "message": _("Policy resolved to native print.")}
            return {
                "status": "dispatched",
                "job_id": res.get("job_id"),
                "message": res.get("message"),
            }

        raise ValidationError(_("No valid action configured for policy %s (action_type: %s)") % (policy.name, policy.action_type))

    @api.model
    def route_raw_command(
        self, raw_data, *, protocol, binding=None, destination=None,
        record=None, company=None, document_type="label", idempotency_key=None,
    ):
        """Directly route raw printer commands (ZPL/TSPL/ESC-POS) without QWeb rendering.

        `protocol` is REQUIRED (no default): a byte stream without an
        explicitly declared language is malformed input, and guessing "zpl"
        for it would misroute it to label hardware.
        """
        if protocol not in ("zpl", "tspl", "escpos", "raw"):
            raise ValidationError(_("Unsupported raw protocol '%s'. Expected zpl, tspl, escpos, or raw.") % protocol)
        current_company = company or (record.company_id if record and hasattr(record, "company_id") else self.env.company)
        config = self._gateway_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}

        if not binding:
            route = self.resolve_binding(
                record=record,
                company=current_company,
                document_type=document_type,
                explicit_destination=destination,
            )
            if route.get("native"):
                return route
            target_binding = route["binding"]
            target_destination = route["destination"]
        else:
            # P1.1 Direct Binding Authorization: Validate caller-supplied binding
            if not binding.enabled:
                raise ValidationError(_("The specified print binding '%s' is disabled.") % binding.display_name)
            binding_effective = binding.branch_id or binding.company_id
            if binding_effective != current_company and binding.company_id != current_company:
                raise ValidationError(
                    _("Print binding '%s' belongs to company '%s', but current operation is for '%s'.")
                    % (binding.display_name, binding_effective.display_name, current_company.display_name)
                )
            if not binding.printer_id:
                raise ValidationError(_("Print binding '%s' has no Gateway Runtime Printer assigned.") % binding.display_name)
            if binding.branch_id and not binding.runtime_agent_id:
                raise ValidationError(_("Print binding '%s' has no Gateway Runtime Agent assigned.") % binding.display_name)

            target_binding = binding
            target_destination = binding.destination_ref or destination

        # Binding Protocol Authorization: EXACT match. A 'raw' binding is a
        # generic byte sink; it does not thereby accept zpl/tspl/escpos. An
        # 'unknown' binding is never routable.
        if target_binding and getattr(target_binding, "printer_protocol", False):
            binding_proto = target_binding.printer_protocol
            if binding_proto != protocol:
                raise ValidationError(
                    _("Protocol mismatch: Binding '%s' is declared %s but this job is %s; protocols must match exactly (there is no wildcard).")
                    % (target_binding.display_name, binding_proto, protocol)
                )

        if isinstance(raw_data, str):
            raw_bytes = raw_data.encode("utf-8")
        else:
            raw_bytes = bytes(raw_data)

        payload = {
            "type": "raw",
            "encoding": "base64",
            "data": base64.b64encode(raw_bytes).decode("ascii"),
            "protocol": protocol,
        }
        # Peripherals are ESC/POS hardware commands: they are attached ONLY
        # for escpos jobs, and ONLY the ACTIVE settings (inactive ones are
        # omitted entirely rather than serialized as "none" actions).
        if target_binding and protocol == "escpos":
            periph = target_binding.get_peripheral_payload()
            if periph:
                payload["peripherals"] = periph

        # P0.3 Deterministic raw idempotency key
        if not idempotency_key:
            if record:
                raw_token = f"{record._name}:{record.id}:{document_type}:{target_binding.id}:{getattr(record, 'write_date', '')}"
                idempotency_key = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
            else:
                idempotency_key = uuid.uuid4().hex

        job_id = self._persist_durable_job({
            "company": current_company,
            "gateway_config": config,
            "printer_id": target_binding.printer_id,
            "destination": target_destination.display_name if hasattr(target_destination, "display_name") else str(target_destination),
            "document_type": document_type,
            "payload": payload,
            "payload_type": "raw_cmd",
            "protocol": protocol,
            "raw_payload": (raw_data.replace("\x00", "\\x00") if isinstance(raw_data, str) else raw_bytes.decode("latin1", errors="replace").replace("\x00", "\\x00")),
            "fallback_binding": target_binding.fallback_binding_id,
            "source_model": record._name if record else False,
            "source_record_id": record.id if record else False,
            "idempotency_key": idempotency_key,
        })
        status = self._submit_durable_job(job_id)
        return {
            "gateway_enabled": True,
            "native": False,
            "status": status,
            "job_id": job_id,
            "message": _("Raw %s print job %s accepted.") % (protocol.upper(), job_id),
        }

    @api.model
    def route_test_page(self, binding):
        """Send a standardized diagnostic test ticket to the target printer."""
        binding.ensure_one()
        current_company = binding.branch_id or binding.company_id
        config = self._gateway_config(current_company)
        if not config:
            raise ValidationError(_("Print Gateway is disabled for company %s.") % current_company.display_name)

        proto = getattr(binding, "printer_protocol", False)
        if not proto:
            raise ValidationError(_("Printer protocol is required on binding '%s' to send a diagnostic test ticket.") % binding.display_name)
        if proto not in ("zpl", "tspl", "raw", "escpos"):
            raise ValidationError(
                _("No canned diagnostic ticket exists for protocol '%s'. Declare an escpos/zpl/tspl/raw protocol on the printer, or print a real report through the Gateway.")
                % (proto or "unknown")
            )
        now_str = fields.Datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        # User-controlled metadata is sanitized per printer language before it
        # is embedded into the command stream: a company named e.g.
        # 'A^XZ\n^XA...' must not inject ZPL commands, and a '"' must not
        # escape a TSPL argument. Plain-text "raw" tickets get control
        # characters stripped as well.
        sanitize = {"zpl": _zpl_text, "tspl": _tspl_text}.get(proto, _escpos_text)
        company_name = sanitize(binding.company_id.name)
        branch_name = sanitize(binding.branch_id.name) if binding.branch_id else "Default / Root"
        agent_id = sanitize(binding.runtime_agent_id or "None")
        printer_name = sanitize(binding.printer_id)

        if proto == "zpl":
            ticket_raw = (
                "^XA\n"
                "^FO50,50^A0N,36,36^FDODOO PRINT GATEWAY DIAGNOSTIC^FS\n"
                "^FO50,100^GB700,2,2^FS\n"
                f"^FO50,120^A0N,28,28^FDCompany : {company_name}^FS\n"
                f"^FO50,160^A0N,28,28^FDBranch  : {branch_name}^FS\n"
                f"^FO50,200^A0N,28,28^FDAgent ID: {agent_id}^FS\n"
                f"^FO50,240^A0N,28,28^FDPrinter : {printer_name}^FS\n"
                f"^FO50,280^A0N,28,28^FDProtocol: ZPL-II^FS\n"
                "^FO50,320^GB700,2,2^FS\n"
                f"^FO50,340^A0N,24,24^FDStatus: OK | {now_str}^FS\n"
                "^XZ\n"
            )
        elif proto == "tspl":
            ticket_raw = (
                "SIZE 75 mm, 50 mm\n"
                "GAP 2 mm, 0 mm\n"
                "DIRECTION 1\n"
                "CLS\n"
                'TEXT 50,40,"3",0,1,1,"ODOO PRINT GATEWAY DIAGNOSTIC"\n'
                f'TEXT 50,80,"2",0,1,1,"Company : {company_name}"\n'
                f'TEXT 50,110,"2",0,1,1,"Branch  : {branch_name}"\n'
                f'TEXT 50,140,"2",0,1,1,"Agent ID: {agent_id}"\n'
                f'TEXT 50,170,"2",0,1,1,"Printer : {printer_name}"\n'
                f'TEXT 50,200,"2",0,1,1,"Protocol: TSPL"\n'
                f'TEXT 50,230,"1",0,1,1,"Status: OK | {now_str}"\n'
                "PRINT 1,1\n"
            )
        elif proto == "raw":
            ticket_raw = (
                "================================\n"
                "  ODOO PRINT GATEWAY DIAGNOSTIC  \n"
                "================================\n"
                f"Company : {company_name}\n"
                f"Branch  : {branch_name}\n"
                f"Agent ID: {agent_id}\n"
                f"Printer : {printer_name}\n"
                f"Area    : {binding.destination_type.upper()}\n"
                "Protocol: RAW\n"
                "--------------------------------\n"
                "Hardware Test Status: OK\n"
                f"Timestamp: {now_str}\n"
                "================================\n\n\n"
            )
        elif proto == "escpos":
            ticket_lines = [
                "\x1b\x40",  # Initialize printer
                "\x1b\x61\x01",  # Centered
                "================================\n",
                "  ODOO PRINT GATEWAY DIAGNOSTIC  \n",
                "================================\n",
                "\x1b\x61\x00",  # Left align
                f"Company : {company_name}\n",
                f"Branch  : {branch_name}\n",
                f"Agent ID: {agent_id}\n",
                f"Printer : {printer_name}\n",
                f"Area    : {binding.destination_type.upper()}\n",
                f"Protocol: {proto.upper()}\n",
                f"Drawer  : {binding.drawer_kick_mode}\n",
                f"Cutter  : {binding.cutter_mode}\n",
                f"Chime   : {binding.buzzer_mode}\n",
                "--------------------------------\n",
                "Hardware Test Status: OK\n",
                f"Timestamp: {now_str}\n",
                "================================\n\n\n",
            ]
            ticket_raw = "".join(ticket_lines)

        return self.route_raw_command(
            ticket_raw,
            protocol=proto,
            binding=binding,
            company=current_company,
            document_type="test_page",
        )

