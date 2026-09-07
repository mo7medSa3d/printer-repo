# -*- coding: utf-8 -*-
"""Odoo 19 POS controller interception for direct report-rendering print endpoints."""

import json

from odoo import http
from odoo.http import request
from odoo.addons.point_of_sale.controllers.main import PosController


class PrintGatewayPosController(PosController):
    @http.route('/pos/sale_details_report', type='http', auth='user')
    def print_sale_details(self, date_start=False, date_stop=False, **kw):
        company = request.env.company
        router = request.env['print_gateway.print_router']
        gateway = router._gateway_config(company)
        if not gateway:
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)

        report = request.env.ref('point_of_sale.sale_details_report', raise_if_not_found=False)
        if not report:
            return request.make_response(
                json.dumps({"error": "POS sale details report is unavailable"}),
                headers=[('Content-Type', 'application/json')],
                status=500,
            )

        render_target = request.env['report.point_of_sale.report_saledetails']
        result = router.route_render_target(
            report,
            render_target,
            company=company,
            document_type='report:point_of_sale.sale_details_report',
            data={'date_start': date_start, 'date_stop': date_stop},
        )
        return request.make_response(
            json.dumps(result),
            headers=[('Content-Type', 'application/json'), ('Cache-Control', 'no-store')],
            status=200,
        )
