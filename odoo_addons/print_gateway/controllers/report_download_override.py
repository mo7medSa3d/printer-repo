# -*- coding: utf-8 -*-
"""Defense-in-depth ReportController override for silent hardware printing."""

import json
from odoo import http
from odoo.http import request
from odoo.addons.web.controllers.report import ReportController


class PrintGatewayReportController(ReportController):

    @http.route(["/report/download"], type="http", auth="user")
    def report_download(self, data, context=None, token=None):
        try:
            requestcontent = json.loads(data)
            url, report_type = requestcontent[0], requestcontent[1]
            if report_type in ("qweb-pdf", "pdf"):
                # URL pattern: /report/pdf/<report_name>/<docids>
                parts = url.split("/")
                if len(parts) >= 4 and parts[1] == "report" and parts[2] in ("pdf", "qweb-pdf"):
                    report_name = parts[3]
                    docids_str = parts[4] if len(parts) > 4 else ""
                    docids = [int(i) for i in docids_str.split(",") if i.isdigit()]

                    router = request.env["print_gateway.print_router"]
                    config = router._gateway_config(request.env.company)
                    if config and docids:
                        report = request.env["ir.actions.report"].sudo().search([("report_name", "=", report_name)], limit=1)
                        if report:
                            records = request.env[report.model].browse(docids).exists()
                            if records:
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
                                except Exception:
                                    # If resolving fails or binding is absent, fall back to native controller
                                    pass
        except Exception:
            pass

        return super().report_download(data, context=context, token=token)
