# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for Gateway-enabled printing."""

import base64
import binascii
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

        with self.env.registry.cursor() as cr:
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
                record = env[model_name].browse(record_id).exists()
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
        return job_id

    @api.model
    def _submit_durable_job(self, job_id):
        """Submit a durable job using a fresh PostgreSQL transaction."""
        with self.env.registry.cursor() as cr:
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

    def _submit_route(
        self, *, route, payload, company, report=None, source_model=None,
        source_record_id=None, idempotency_key=None,
    ):
        self._assert_current_company(company)
        binding = route.get("binding")
        if binding and isinstance(payload, dict):
            payload["peripherals"] = binding.get_peripheral_payload()
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

        # If policy specifies a report, render standard report
        if policy.report_id:
            route = self.resolve_binding(
                report=policy.report_id,
                record=target_record,
                company=company,
                explicit_destination=policy.binding_id.destination_ref if policy.binding_id else None,
            )
            if route.get("native"):
                return route
            return self._submit_route(
                route=route,
                payload=self._render_pdf_payload(policy.report_id, target_record),
                company=company,
                report=policy.report_id,
                source_model=target_record._name,
                source_record_id=target_record.id,
                idempotency_key=intent.intent_key,
            )

        # If policy specifies raw command (e.g. barcode label)
        if getattr(policy, "action_type", False) == "raw_template" or (not policy.report_id and getattr(policy, "raw_template", False)):
            raw_data = policy.render_raw_template(target_record)
            return self.route_raw_command(
                raw_data,
                protocol=policy.raw_protocol or "zpl",
                binding=policy.binding_id or False,
                record=target_record,
                company=company,
                document_type="label",
            )

        raise ValidationError(_("No report or raw label action configured for policy %s") % policy.name)

    @api.model
    def route_raw_command(self, raw_data, *, protocol="zpl", binding=None, destination=None, record=None, company=None, document_type="label"):
        """Directly route raw printer commands (ZPL/TSPL/ESC-POS) without QWeb rendering."""
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
            target_binding = binding
            target_destination = binding.destination_ref

        if isinstance(raw_data, str):
            raw_bytes = raw_data.encode("utf-8")
        else:
            raw_bytes = bytes(raw_data)

        payload = {
            "type": "raw",
            "encoding": "base64",
            "data": base64.b64encode(raw_bytes).decode("ascii"),
        }
        if target_binding:
            payload["peripherals"] = {
                "drawer": target_binding.drawer_kick_mode if target_binding.drawer_kick_mode != "none" else "none",
                "cutter": target_binding.cutter_mode if target_binding.cutter_mode != "none" else "none",
                "buzzer": target_binding.buzzer_mode if target_binding.buzzer_mode != "none" else "none",
            }

        job_id = self._persist_durable_job({
            "company": current_company,
            "gateway_config": config,
            "printer_id": target_binding.printer_id,
            "destination": target_destination.display_name if hasattr(target_destination, "display_name") else str(target_destination),
            "document_type": document_type,
            "payload": payload,
            "payload_type": "raw_cmd",
            "protocol": protocol,
            "raw_payload": raw_data if isinstance(raw_data, str) else raw_bytes.decode("latin1", errors="replace"),
            "fallback_binding": target_binding.fallback_binding_id,
            "source_model": record._name if record else False,
            "source_record_id": record.id if record else False,
            "idempotency_key": uuid.uuid4().hex,
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

        ticket_lines = [
            "\x1b\x40",  # Initialize printer
            "\x1b\x61\x01",  # Centered
            "================================\n",
            "  ODOO PRINT GATEWAY DIAGNOSTIC  \n",
            "================================\n",
            "\x1b\x61\x00",  # Left align
            f"Company : {binding.company_id.name}\n",
            f"Branch  : {binding.branch_id.name if binding.branch_id else 'Default / Root'}\n",
            f"Agent ID: {binding.runtime_agent_id}\n",
            f"Printer : {binding.printer_id}\n",
            f"Area    : {binding.destination_type.upper()}\n",
            f"Drawer  : {binding.drawer_kick_mode}\n",
            f"Cutter  : {binding.cutter_mode}\n",
            f"Chime   : {binding.buzzer_mode}\n",
            "--------------------------------\n",
            "Hardware Test Status: OK\n",
            "Timestamp: " + fields.Datetime.now().strftime("%Y-%m-%d %H:%M:%S") + "\n",
            "================================\n\n\n",
            "\x1d\x56\x01",  # Cut
        ]
        ticket_raw = "".join(ticket_lines)
        return self.route_raw_command(
            ticket_raw,
            protocol="escpos",
            binding=binding,
            company=current_company,
            document_type="test_page",
        )
