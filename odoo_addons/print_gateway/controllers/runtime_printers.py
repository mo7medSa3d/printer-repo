# -*- coding: utf-8 -*-
import requests

from odoo import http
from odoo.http import request
from odoo.exceptions import ValidationError


class PrintGatewayRuntimePrinterController(http.Controller):
    @http.route('/print_gateway/runtime-printers', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_printers(self):
        company = request.env.company
        config = request.env['print_gateway.gateway_config'].search([('company_id', '=', company.id)], limit=1)
        if not config or not config.enabled:
            return {'enabled': False, 'printers': []}
        try:
            response = requests.get(
                '%s/api/odoo/printers' % config._gateway_base(for_request=True),
                headers=config._gateway_headers(),
                timeout=(5, 10),
                allow_redirects=False,
            )
            if response.status_code != 200:
                raise ValidationError('Gateway printer discovery failed (HTTP %s).' % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError('Gateway printer discovery is unavailable.') from exc
        printers = body.get('printers') if isinstance(body, dict) else None
        if not isinstance(printers, list):
            raise ValidationError('Gateway returned an invalid printer discovery response.')
        sanitized = []
        for printer in printers:
            if not isinstance(printer, dict):
                continue
            printer_id = printer.get('id')
            if not isinstance(printer_id, str) or not printer_id.strip():
                continue
            name = printer.get('name') if isinstance(printer.get('name'), str) else 'Unnamed printer'
            status = printer.get('status') if isinstance(printer.get('status'), str) else 'unknown'
            lifecycle = printer.get('lifecycle') if isinstance(printer.get('lifecycle'), str) else 'active'
            agent = printer.get('agent') if isinstance(printer.get('agent'), dict) else {}
            agent_name = agent.get('name') if isinstance(agent.get('name'), str) else ''
            if lifecycle == 'retired':
                continue
            sanitized.append({
                'id': printer_id,
                'name': name,
                'status': status,
                'agentName': agent_name,
            })
        return {'enabled': True, 'printers': sanitized}
