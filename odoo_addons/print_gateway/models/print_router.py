# -*- coding: utf-8 -*-
"""Single Odoo print-routing authority for Gateway-enabled printing."""

import base64
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


class PrintGatewayRouter(models.AbstractModel):
    _name = "print_gateway.print_router"
    _description = "Print Gateway Central Router"

    @api.model
    def _gateway_config(self, company):
        config = self.env["print_gateway.gateway_config"].search(
            [("company_id", "=", company.id)], limit=1,
        )
        return config if config and config.enabled else False

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
    def destination_for(self, *, report=None, record=None):
        return self.env["print_gateway.binding"].destination_for(record=record, report=report)

    @api.model
    def _company_for_record(self, record):
        return getattr(record, "company_id", False) or self.env.company

    @api.model
    def resolve_binding(self, *, report=None, record=None, document_type=None, company=None):
        company = company or (self._company_for_record(record) if record else self.env.company)
        config = self._gateway_config(company)
        if not config:
            return {"gateway_enabled": False, "native": True}
        dtype = self._document_type(report=report, record=record, explicit=document_type)
        destination = self.destination_for(report=report, record=record)
        binding = self.env["print_gateway.binding"].find_for(
            company, dtype, report=report, record=record,
        )
        if not binding:
            raise ValidationError(_(
                "Gateway printing is enabled, but no Print Binding exists for %s (%s)."
            ) % (destination.display_name, dtype))
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "document_type": dtype,
            "destination": destination,
        }

    @staticmethod
    def _validate_pdf(pdf_content, report):
        if isinstance(pdf_content, (list, tuple)):
            pdf_content = pdf_content[0] if pdf_content else b""
        if not pdf_content or not bytes(pdf_content).startswith(b"%PDF-"):
            raise ValidationError(_("The rendered report %s is not a valid PDF.") % report.display_name)
        return bytes(pdf_content)

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
        pdf_content = self._validate_pdf(pdf_content, report)
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(pdf_content).decode("ascii"),
        }

    @api.model
    def _render_pdf_payload_from_target(self, report, render_target, data=None):
        """Render a report that is invoked directly by a controller/service instead of report_action()."""
        report.ensure_one()
        try:
            pdf_content, _ = report._render_qweb_pdf(report, res_ids=render_target, data=data)
        except Exception as exc:
            raise ValidationError(_("Failed to render %s for Gateway printing.") % report.display_name) from exc
        pdf_content = self._validate_pdf(pdf_content, report)
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(pdf_content).decode("ascii"),
        }

    @api.model
    def _persist_durable_job(self, values):
        registry = self.env.registry
        with registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            job = env["print_gateway.print_job"].create_operation(**values)
            job_id = job.id
            cr.commit()
        return self.env["print_gateway.print_job"].browse(job_id)

    def _submit_route(self, *, route, payload, company, report, source_model=None, source_record_id=None):
        job = self._persist_durable_job({
            "company": company,
            "gateway_config": route["config"],
            "printer_id": route["binding"].printer_id,
            "destination": route["destination"].display_name,
            "document_type": route["document_type"],
            "payload": payload,
            "source_model": source_model,
            "source_record_id": source_record_id,
            "report": report,
            "idempotency_key": uuid.uuid4().hex,
        })
        job.action_submit(raise_on_failure=True)
        return {
            "gateway_enabled": True,
            "native": False,
            "status": job.status,
            "job_id": job.id,
            "message": _("Print job %s accepted by the Gateway.") % job.id,
        }

    @api.model
    def route_report(self, report, records, data=None):
        report.ensure_one()
        records = records.exists()
        if not records:
            config = self._gateway_config(self.env.company)
            if config:
                raise ValidationError(_("Gateway printing requires at least one report record."))
            return {"gateway_enabled": False, "native": True}

        route = self.resolve_binding(report=report, record=records[0])
        if route.get("native"):
            return route
        for record in records[1:]:
            current = self.resolve_binding(report=report, record=record)
            if current["binding"].id != route["binding"].id:
                raise ValidationError(_("The selected records resolve to different Print Bindings. Print them separately."))

        payload = self._render_pdf_payload(report, records, data=data)
        return self._submit_route(
            route=route,
            payload=payload,
            company=self._company_for_record(records[0]),
            report=report,
            source_model=records[0]._name,
            source_record_id=records[0].id,
        )

    @api.model
    def route_render_target(self, report, render_target, *, company=None, document_type=None, data=None):
        """Route a direct Odoo report-rendering endpoint through the same router.

        This exists specifically for controller/service print entry points that bypass
        ir.actions.report.report_action(), while keeping report rendering itself intact.
        """
        report.ensure_one()
        company = company or self.env.company
        route = self.resolve_binding(
            report=report,
            record=None,
            document_type=document_type,
            company=company,
        )
        if route.get("native"):
            return route
        payload = self._render_pdf_payload_from_target(report, render_target, data=data)
        return self._submit_route(
            route=route,
            payload=payload,
            company=company,
            report=report,
            source_model=report.model,
        )

    @api.model
    def route_pos_receipt(self, order):
        order.ensure_one()
        if not order.id or not order.exists():
            raise ValidationError(_("The POS order must be synchronized before Gateway printing."))
        report = self.env.ref("point_of_sale.action_report_receipt", raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The POS receipt report is unavailable."))
        return self.route_report(report, order)
