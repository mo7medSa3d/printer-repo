# -*- coding: utf-8 -*-
"""Odoo POS HTTP boundaries that bypass ``report_action``."""

import json

from odoo import http
from odoo.http import request
from odoo.addons.point_of_sale.controllers.main import PosController


class PrintGatewayPosController(PosController):
    """Intercept the verified direct Sale Details report route."""

    @http.route('/pos/sale_details_report', type='http', auth='user')
    def print_sale_details(self, date_start=False, date_stop=False, **kw):
        accept = request.httprequest.headers.get('Accept', '')
        if 'application/pdf' in accept:
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)

        gateway = request.env['print_gateway.print_router']._gateway_config(request.env.company)
        if not gateway:
            return super().print_sale_details(date_start=date_start, date_stop=date_stop, **kw)

        render_target = request.env['report.point_of_sale.report_saledetails']
        result = request.env['print_gateway.print_router'].route_render_target(
            'point_of_sale.sale_details_report',
            render_target,
            company=request.env.company,
            document_type='report:point_of_sale.sale_details_report',
            context_values={'date_start': date_start, 'date_stop': date_stop},
        )
        response = request.make_response(
            json.dumps(result, default=str),
            headers=[
                ('Content-Type', 'application/json'),
                ('Cache-Control', 'no-store'),
            ],
        )
        response.status_code = 202
        return response
