# -*- coding: utf-8 -*-
"""Defense-in-depth ReportController override for silent hardware printing."""

import json
import urllib.parse
from odoo import http
from odoo.exceptions import AccessError
from odoo.http import request
from odoo.addons.web.controllers.report import ReportController


class PrintGatewayReportController(ReportController):

    @http.route(["/report/download"], type="http", auth="user")
    def report_download(self, data, context=None, token=None):
        router = request.env["print_gateway.print_router"]
        config = router._gateway_config(request.env.company)

        try:
            requestcontent = json.loads(data)
            url, report_type = requestcontent[0], requestcontent[1]
            if report_type in ("qweb-pdf", "pdf"):
                parsed_url = urllib.parse.urlparse(url)
                parts = [p for p in parsed_url.path.split("/") if p]
                # URL pattern: /report/pdf/<report_name>/<docids> -> ['report', 'pdf', '<report_name>', '<docids>']
                if len(parts) >= 3 and parts[0] == "report" and parts[1] in ("pdf", "qweb-pdf"):
                    report_name = parts[2]
                    docids_str = parts[3] if len(parts) > 3 else ""
                    docids = [int(i) for i in docids_str.split(",") if i.isdigit()]

                    if config:
                        if not docids:
                            return request.make_response(
                                json.dumps({"error": "invalid_report_request", "message": "No valid document IDs specified."}),
                                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                                status=400,
                            )
                        report = request.env["ir.actions.report"].sudo().search([("report_name", "=", report_name)], limit=1)
                        if not report:
                            return request.make_response(
                                json.dumps({"error": "report_not_found", "message": f"Report '{report_name}' not found."}),
                                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                                status=404,
                            )
                        # Security / IDOR: Verify current user has explicit read access to the records
                        records = request.env[report.model].browse(docids).exists()
                        if len(records) != len(docids):
                            return request.make_response(
                                json.dumps({"error": "records_not_found", "message": "One or more requested records do not exist."}),
                                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                                status=404,
                            )
                        try:
                            records.check_access("read")
                        except AccessError as exc:
                            return request.make_response(
                                json.dumps({"error": "forbidden", "message": str(exc)}),
                                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                                status=403,
                            )

                        try:
                            route = router.resolve_binding(report=report, record=records[0], company=request.env.company)
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
                        except Exception as exc:
                            # Fail-closed: Never fall back to native browser PDF download
                            # when Gateway is configured and dispatch/routing failed
                            return request.make_response(
                                json.dumps({
                                    "error": "gateway_dispatch_failed",
                                    "message": str(exc),
                                }),
                                headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                                status=502,
                            )
        except Exception as exc:
            if config:
                return request.make_response(
                    json.dumps({
                        "error": "gateway_request_error",
                        "message": str(exc),
                    }),
                    headers=[("Content-Type", "application/json"), ("Cache-Control", "no-store")],
                    status=502,
                )

        return super().report_download(data, context=context, token=token)


