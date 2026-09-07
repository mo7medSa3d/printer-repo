# -*- coding: utf-8 -*-
"""Single print-routing entry point for all Gateway-enabled Odoo printing."""

import base64

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
            [("company_id", "=", company.id)], limit=1
        )
        return config if config.enabled else False

    @api.model
    def _document_type(self, report=None, record=None, explicit=None):
        value = explicit or self.env.context.get("print_gateway_document_type")
        if value:
            return str(value).strip().lower()
        if record and record._name in REPORT_DOCUMENT_TYPES:
            return REPORT_DOCUMENT_TYPES[record._name]
        if report and report.model in REPORT_DOCUMENT_TYPES:
            return REPORT_DOCUMENT_TYPES[report.model]
        if report and "invoice" in (report.report_name or "").lower():
            return "invoice"
        if report and "receipt" in (report.report_name or "").lower():
            return "receipt"
        return "document"

    @api.model
    def _company_for_record(self, record):
        company = getattr(record, "company_id", False)
        return company or self.env.company

    @api.model
    def _destination(self, report=None, record=None):
        if record and record._name == "pos.order" and "config_id" in record._fields and record.config_id:
            return record.config_id
        if record and record._name == "stock.picking" and "picking_type_id" in record._fields and record.picking_type_id:
            return record.picking_type_id
        if report:
            return report
        company = self._company_for_record(record) if record else self.env.company
        return company

    @api.model
    def resolve_binding(self, *, report=None, record=None, document_type=None):
        company = self._company_for_record(record) if record else (report.company_id if report and "company_id" in report._fields and report.company_id else self.env.company)
        config = self._gateway_config(company)
        if not config:
            return {"gateway_enabled": False, "native": True}
        dtype = self._document_type(report=report, record=record, explicit=document_type)
        binding = self.env["print_gateway.binding"].find_for(
            company,
            dtype,
            report=report,
            record=record,
        )
        if not binding:
            raise ValidationError(
                _("Gateway printing is enabled, but no Print Binding exists for %s (%s).")
                % (self._destination(report=report, record=record).display_name, dtype)
            )
        return {
            "gateway_enabled": True,
            "native": False,
            "config": config,
            "binding": binding,
            "document_type": dtype,
            "destination": self._destination(report=report, record=record),
        }

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
        if isinstance(pdf_content, (list, tuple)):
            pdf_content = pdf_content[0] if pdf_content else b""
        if not pdf_content or not bytes(pdf_content).startswith(b"%PDF-"):
            raise ValidationError(_("The rendered report is not a valid PDF."))
        return {
            "type": "pdf",
            "encoding": "base64",
            "data": base64.b64encode(bytes(pdf_content)).decode("ascii"),
        }

    @api.model
    def route_report(self, report, records, data=None):
        report.ensure_one()
        records = records.exists()
        if not records:
            raise ValidationError(_("Cannot print an empty report."))
        route = self.resolve_binding(report=report, record=records[0])
        if route.get("native"):
            return {"gateway_enabled": False, "native": True}

        for record in records:
            current = self.resolve_binding(report=report, record=record)
            if current["binding"].id != route["binding"].id:
                raise ValidationError(
                    _("The selected records resolve to different print bindings. Print them separately.")
                )

        payload = self._render_pdf_payload(report, records, data=data)
        key = "report:%s:%s:%s" % (
            report.id,
            ",".join(str(record.id) for record in records),
            self.env.context.get("print_gateway_request_token") or self.env.context.get("request_id") or "manual",
        )
        job = self.env["print_gateway.print_job"].create_operation(
            company=self._company_for_record(records[0]),
            gateway_config=route["config"],
            printer_id=route["binding"].printer_id,
            destination=route["destination"].display_name,
            document_type=route["document_type"],
            payload=payload,
            source_model=records[0]._name,
            source_record_id=records[0].id,
            report=report,
            idempotency_key=key,
        )
        return {
            "gateway_enabled": True,
            "native": False,
            "status": job.status,
            "job_id": job.id,
            "message": _("Print job %s queued.") % job.id,
        }

    @api.model
    def route_pos_receipt(self, order):
        order.ensure_one()
        if not order.id or not order.exists():
            raise ValidationError(_("The POS order must be synchronized before Gateway printing."))
        report = self.env.ref("point_of_sale.action_report_receipt", raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The POS receipt report is unavailable."))
        return self.route_report(report, order)
