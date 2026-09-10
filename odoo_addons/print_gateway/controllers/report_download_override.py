# -*- coding: utf-8 -*-
"""Defense-in-depth ReportController override for silent hardware printing."""

import json
import logging
import urllib.parse
from odoo import http
from odoo.exceptions import AccessError
from odoo.http import request
from odoo.addons.web.controllers.report import ReportController

_logger = logging.getLogger(__name__)


class PrintGatewayReportController(ReportController):

    @http.route(["/report/download"], type="http", auth="user")
    def report_download(self, data, context=None, token=None):
        try:
            requestcontent = json.loads(data)
            url, report_type = requestcontent[0], requestcontent[1]
        except Exception:
            return super().report_download(data, context=context, token=token)

        if report_type not in ("qweb-pdf", "pdf"):
            return super().report_download(data, context=context, token=token)

        parsed_url = urllib.parse.urlparse(url)
        parts = [p for p in parsed_url.path.split("/") if p]
        if not (len(parts) >= 3 and parts[0] == "report" and parts[1] in ("pdf", "qweb-pdf")):
            return super().report_download(data, context=context, token=token)

        report_name = parts[2]
        docids_str = parts[3] if len(parts) > 3 else ""
        if not docids_str:
            docids = []
        else:
            tokens = docids_str.split(",")
            if not all(t.isdigit() for t in tokens):
                return request.make_response(
                    json.dumps({"error": "invalid_report_request", "message": "Malformed document IDs."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=400,
                )
            docids = [int(t) for t in tokens]

        router = request.env["print_gateway.print_router"]
        try:
            gateway_company, _branch = router._binding_scope(request.env.company)
            cfg_record = request.env["print_gateway.gateway_config"].sudo().search(
                [("company_id", "=", gateway_company.id)], limit=1,
            )
            is_gateway_enabled = bool(cfg_record and cfg_record.enabled)
        except Exception as exc:
            _logger.exception("Error checking gateway configuration: %s", exc)
            return request.make_response(
                json.dumps({
                    "error": "gateway_config_error",
                    "message": "An error occurred while evaluating Print Gateway configuration.",
                }),
                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                status=502,
            )

        if not is_gateway_enabled:
            return super().report_download(data, context=context, token=token)

        # Gateway mode is active: any error or invalid config MUST fail closed
        try:
            config = router._gateway_config(request.env.company)
            if not config:
                _logger.error("Gateway enabled but _gateway_config returned false/empty for %s", request.env.company.name)
                return request.make_response(
                    json.dumps({
                        "error": "gateway_config_invalid",
                        "message": "Print Gateway configuration is enabled but invalid.",
                    }),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=502,
                )

            if not docids:
                return request.make_response(
                    json.dumps({"error": "invalid_report_request", "message": "No valid document IDs specified."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=400,
                )

            # Security / IDOR: Verify current user has explicit read access to the report action
            report = request.env["ir.actions.report"].search([("report_name", "=", report_name)], limit=1)
            if not report:
                return request.make_response(
                    json.dumps({"error": "report_not_found", "message": "The requested report was not found."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=404,
                )
            try:
                report.check_access("read")
            except AccessError:
                return request.make_response(
                    json.dumps({"error": "forbidden", "message": "Access denied to requested report."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=403,
                )

            # Security / IDOR: Verify current user has explicit read access to the records in user context
            records = request.env[report.model].browse(docids).exists()
            if len(records) != len(docids):
                return request.make_response(
                    json.dumps({"error": "records_not_found", "message": "One or more requested records do not exist."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=404,
                )
            try:
                records.check_access("read")
            except AccessError:
                return request.make_response(
                    json.dumps({"error": "forbidden", "message": "Access denied to requested records."}),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=403,
                )

            # Multi-record Scope Isolation: Verify all records belong to compatible scopes and bindings
            initial_route = None
            for rec in records:
                rec_route = router.resolve_binding(report=report, record=rec, company=request.env.company)
                if initial_route is None:
                    initial_route = rec_route
                else:
                    initial_binding = initial_route.get("binding")
                    rec_binding = rec_route.get("binding")
                    initial_binding_id = initial_binding.id if hasattr(initial_binding, "id") else initial_route.get("binding_id")
                    rec_binding_id = rec_binding.id if hasattr(rec_binding, "id") else rec_route.get("binding_id")
                    initial_printer = getattr(initial_binding, "printer_id", None) or initial_route.get("printer_id")
                    rec_printer = getattr(rec_binding, "printer_id", None) or rec_route.get("printer_id")
                    initial_agent = getattr(initial_binding, "runtime_agent_id", None) or initial_route.get("runtime_agent_id")
                    rec_agent = getattr(rec_binding, "runtime_agent_id", None) or rec_route.get("runtime_agent_id")

                    if (
                        rec_binding_id != initial_binding_id
                        or rec_printer != initial_printer
                        or rec_agent != initial_agent
                        or rec_route.get("gateway_enabled") != initial_route.get("gateway_enabled")
                        or rec_route.get("native") != initial_route.get("native")
                    ):
                        _logger.warning("Rejected mixed-scope multi-record print request for report %s", report_name)
                        return request.make_response(
                            json.dumps({
                                "error": "mixed_scope_batch",
                                "message": "Multi-record print batch spans multiple companies, branches, or destinations.",
                            }),
                            headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                            status=400,
                        )

            route = initial_route
            if not route.get("native") and route.get("gateway_enabled"):
                submit_res = router.route_report(report, records)
                response = request.make_response(
                    json.dumps({
                        "status": "dispatched_to_gateway",
                        "job_id": submit_res.get("job_id"),
                        "message": submit_res.get("message"),
                    }),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=200,
                )
                if token:
                    response.set_cookie("fileToken", token)
                return response
            else:
                return super().report_download(data, context=context, token=token)

        except Exception as exc:
            _logger.exception("Failed to dispatch Gateway print for report %s: %s", report_name, exc)
            return request.make_response(
                json.dumps({
                    "error": "gateway_dispatch_failed",
                    "message": "Printing failed due to a gateway communication or routing error.",
                }),
                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                status=502,
            )


