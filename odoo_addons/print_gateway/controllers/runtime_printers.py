# -*- coding: utf-8 -*-
import requests

from odoo import http
from odoo.http import request
from odoo.exceptions import ValidationError


class PrintGatewayRuntimePrinterController(http.Controller):
    def _scope(self, company_id=None, branch_id=None):
        env = request.env
        company = env["res.company"].browse(company_id or env.company.id).exists()
        if not company or company not in env.companies:
            raise ValidationError("The selected Odoo Company is not available to the current user.")
        if company.parent_id:
            raise ValidationError("The selected Odoo Company must be a parent Company, not a Branch.")
        branch = env["res.company"].browse(branch_id).exists() if branch_id else False
        if branch:
            if branch not in env.companies:
                raise ValidationError("The selected Odoo Branch is not available to the current user.")
            if branch.parent_id != company:
                raise ValidationError("Odoo Branch must belong directly to the selected Odoo Company.")
        return company, branch

    def _get_config(self, company):
        config = request.env["print_gateway.gateway_config"].search(
            [("company_id", "=", company.id)], limit=1,
        )
        return config, company

    @http.route('/print_gateway/runtime-agents', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_agents(self, company_id=None, branch_id=None):
        company, branch = self._scope(company_id, branch_id)
        if not branch:
            raise ValidationError("An Odoo Branch is required for runtime-agent assignment.")
        config, root_company = self._get_config(company)
        if not config or not config.enabled:
            return {'enabled': False, 'selectedAgentId': False, 'agents': []}
        try:
            response = requests.get(
                '%s/api/odoo/agents' % config._gateway_base(for_request=True),
                headers=config._gateway_headers(), timeout=(5, 10), allow_redirects=False,
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
            lifecycle = agent.get('lifecycle') if isinstance(agent.get('lifecycle'), str) else 'active'
            if not isinstance(agent_id, str) or not agent_id.strip() or lifecycle == 'retired':
                continue
            sanitized.append({
                'id': agent_id,
                'name': agent.get('name') if isinstance(agent.get('name'), str) else agent_id,
                'status': agent.get('status') if isinstance(agent.get('status'), str) else 'offline',
            })
        assignment = request.env['print_gateway.runtime_agent_assignment'].sudo().search([
            ('company_id', '=', root_company.id), ('branch_id', '=', branch.id), ('enabled', '=', True),
        ], limit=1)
        return {'enabled': True, 'selectedAgentId': assignment.runtime_agent_id if assignment else False, 'agents': sanitized}

    @http.route('/print_gateway/runtime-printers', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_printers(self, company_id=None, branch_id=None, agent_id=None):
        company, branch = self._scope(company_id, branch_id)
        if not branch:
            raise ValidationError("An Odoo Branch is required for runtime-printer selection.")
        if not isinstance(agent_id, str) or not agent_id.strip():
            return {'enabled': True, 'selectedAgentId': False, 'printers': []}
        config, _root_company = self._get_config(company)
        if not config or not config.enabled:
            return {'enabled': False, 'selectedAgentId': False, 'printers': []}
        try:
            response = requests.get(
                '%s/api/odoo/printers' % config._gateway_base(for_request=True),
                headers=config._gateway_headers(), timeout=(5, 10), allow_redirects=False,
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
            lifecycle = printer.get('lifecycle') if isinstance(printer.get('lifecycle'), str) else 'active'
            agent = printer.get('agent') if isinstance(printer.get('agent'), dict) else {}
            returned_agent_id = agent.get('id') if isinstance(agent.get('id'), str) else ''
            if lifecycle == 'retired' or returned_agent_id != agent_id:
                continue
            sanitized.append({
                'id': printer_id,
                'name': printer.get('name') if isinstance(printer.get('name'), str) else printer_id,
                'status': printer.get('status') if isinstance(printer.get('status'), str) else 'unknown',
                'deviceClass': printer.get('deviceClass') if isinstance(printer.get('deviceClass'), str) else 'unknown',
                'connectionType': printer.get('connectionType') if isinstance(printer.get('connectionType'), str) else 'unknown',
                'protocol': printer.get('protocol') if isinstance(printer.get('protocol'), str) else 'unknown',
                'agentId': returned_agent_id,
                'agentName': agent.get('name') if isinstance(agent.get('name'), str) else agent_id,
            })
        return {'enabled': True, 'selectedAgentId': agent_id, 'printers': sanitized}
