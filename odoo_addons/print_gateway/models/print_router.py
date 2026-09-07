# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for Gateway-enabled printing."""

import base64
import binascii
import uuid

from odoo import api, models, _
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
    def _gateway_config(self, company):
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", company.id)], limit=1)
        return config if config and config.enabled else False

    @api.model
    def _assert_current_company(self, company, record=None):
        current = self.env.company
        if not company or company != current:
            raise ValidationError(
                _("Print routing must use the active Odoo company (%s).") % current.display_name
            )
        if record and getattr(record, "company_id", False) and record.company_id != current:
            raise ValidationError(
                _("The printable document belongs to %s, but the active Odoo company is %s.")
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
        config = self._gateway_config(current_company)
        if not config:
            return {"gateway_enabled": False, "native": True}
        dtype = self._document_type(report=report, record=record, explicit=document_type)
        destination = self.destination_for(
            report=report,
            record=record,
            explicit_destination=explicit_destination,
        )
        binding = self.env["print_gateway.binding"].find_for(
            current_company,
            dtype,
            report=report,
            record=record,
            explicit_destination=explicit_destination,
        )
        if not binding:
            raise ValidationError(
                _("Gateway printing is enabled, but no Print Binding exists for %s (%s).")
                % (destination.display_name, dtype)
            )
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "document_type": dtype,
            "destination": destination,
            "company": current_company,
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
        """Create the durable Odoo outbox row in an independent transaction.

        The caller's Odoo transaction may already have an active PostgreSQL
        snapshot. Returning an ORM recordset from the independent cursor would
        therefore be unsafe: that snapshot may not see the newly committed row.
        Return only the immutable database id and let the caller cross the
        transaction boundary explicitly.
        """
        durable_values = dict(values)
        for key in ("company", "gateway_config", "report"):
            record = durable_values.get(key)
            durable_values[key] = record.id if record else False

        with self.env.registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            for key, model_name in (
                ("company", "res.company"),
                ("gateway_config", "print_gateway.gateway_config"),
                ("report", "ir.actions.report"),
            ):
                record_id = durable_values.get(key)
                if not record_id:
                    durable_values[key] = False
                    continue
                record = env[model_name].browse(record_id).exists()
                if not record:
                    raise ValidationError(_("The durable print operation references a record that is no longer available."))
                durable_values[key] = record
            job = env["print_gateway.print_job"].create_operation(**durable_values)
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
                job.action_submit(raise_on_failure=True)
                status = job.status
                cr.commit()
                return status
            except Exception:
                cr.rollback()
                raise

    def _submit_route(
        self,
        *,
        route,
        payload,
        company,
        report=None,
        source_model=None,
        source_record_id=None,
        idempotency_key=None,
    ):
        self._assert_current_company(company)
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
        self,
        report_ref,
        render_target,
        *,
        company=None,
        document_type=None,
        explicit_destination=None,
        context_values=None,
    ):
        report = self.env.ref(report_ref, raise_if_not_found=False) if isinstance(report_ref, str) else report_ref
        if not report:
            raise ValidationError(_("The requested report is unavailable."))
        report.ensure_one()
        company = company or self.env.company
        self._assert_current_company(company)
        route = self.resolve_binding(
            report=report,
            document_type=document_type,
            company=company,
            explicit_destination=explicit_destination,
        )
        if route.get("native"):
            return route
        payload = self._render_pdf_payload_from_target(
            report.get_external_id().get(report.id, report.report_name),
            render_target,
            context_values=context_values,
        )
        return self._submit_route(
            route=route,
            payload=payload,
            company=company,
            report=report,
            source_model=report.model,
        )

    @api.model
    def route_pos_receipt(self, order, image_base64):
        order.ensure_one()
        self._assert_current_company(order.company_id, record=order)
        self._validate_jpeg_base64(image_base64)
        route = self.resolve_binding(record=order, company=self.env.company, document_type="receipt")
        if route.get("native"):
            return route
        return self._submit_route(
            route=route,
            payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company,
            source_model=order._name,
            source_record_id=order.id,
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
            record=order,
            company=company,
            document_type="kitchen",
            explicit_destination=native_printer,
        )
        if route.get("native"):
            return route
        stable_key = "%s:%s" % (idempotency_key or uuid.uuid4().hex, native_printer.id)
        return self._submit_route(
            route=route,
            payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=company,
            source_model=order._name,
            source_record_id=order.id,
            idempotency_key=stable_key,
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
            route=route,
            payload={"type": "image", "encoding": "base64", "data": image_base64},
            company=self.env.company,
            source_model=session._name,
            source_record_id=session.id,
        )
