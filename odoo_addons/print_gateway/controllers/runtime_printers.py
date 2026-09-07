# -*- coding: utf-8 -*-
import requests

from odoo import http
from odoo.http import request
from odoo.exceptions import ValidationError


class PrintGatewayRuntimePrinterController(http.Controller):
    def _get_config(self):
        company = request.env.company
        config = request.env['print_gateway.gateway_config'].search([('company_id', '=', company.id)], limit=1)
        return config

    @http.route('/print_gateway/runtime-agents', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_agents(self):
        config = self._get_config()
        if not config or not config.enabled:
            return {'enabled': False, 'selectedAgentId': False, 'agents': []}
        try:
            response = requests.get(
                '%s/api/odoo/agents' % config._gateway_base(for_request=True),
                headers=config._gateway_headers(),
                timeout=(5, 10),
                allow_redirects=False,
            )
            if response.status_code != 200:
                raise ValidationError('Gateway agent discovery failed (HTTP %s).' % response.status_code)
            body = response.json()
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError('Gateway agent discovery is unavailable.') from exc
        agents = body.get('agents') if isinstance(body, dict) else None
        if not isinstance(agents, list):
            raise ValidationError('Gateway returned an invalid agent discovery response.')
        sanitized = []
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            agent_id = agent.get('id')
            if not isinstance(agent_id, str) or not agent_id.strip():
                continue
            lifecycle = agent.get('lifecycle') if isinstance(agent.get('lifecycle'), str) else 'active'
            if lifecycle == 'retired':
                continue
            sanitized.append({
                'id': agent_id,
                'name': agent.get('name') if isinstance(agent.get('name'), str) else agent_id,
                'status': agent.get('status') if isinstance(agent.get('status'), str) else 'offline',
            })
        return {
            'enabled': True,
            'selectedAgentId': config.runtime_agent_id or False,
            'agents': sanitized,
        }

    @http.route('/print_gateway/runtime-printers', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_printers(self):
        config = self._get_config()
        if not config or not config.enabled:
            return {'enabled': False, 'selectedAgentId': False, 'agents': [], 'printers': []}
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
        agents = {}
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
            agent_id = agent.get('id') if isinstance(agent.get('id'), str) else ''
            agent_name = agent.get('name') if isinstance(agent.get('name'), str) else ''
            if lifecycle == 'retired' or not agent_id:
                continue
            agents[agent_id] = {'id': agent_id, 'name': agent_name or agent_id}
            if config.runtime_agent_id and agent_id != config.runtime_agent_id:
                continue
            sanitized.append({
                'id': printer_id,
                'name': name,
                'status': status,
                'agentId': agent_id,
                'agentName': agent_name,
            })
        return {
            'enabled': True,
            'selectedAgentId': config.runtime_agent_id or False,
            'agents': sorted(agents.values(), key=lambda item: item['name'].lower()),
            'printers': sanitized,
        }
