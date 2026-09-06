# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import requests
import logging
import time
import uuid
import json

_logger = logging.getLogger(__name__)


class PrintGatewayBranch(models.Model):
    _name = 'print_gateway.branch'
    _description = 'Print Gateway Branch'
    _order = 'name'

    name = fields.Char(string='Branch Name', required=True, help='Name inherited from the Odoo company/branch.')
    company_id = fields.Many2one('res.company', string='Company', ondelete='cascade')
    gateway_url = fields.Char(string='Gateway URL', required=True, help='Base URL of print gateway. http:// and https:// are supported; do not include a trailing slash.')
    gateway_api_key = fields.Char(string='Gateway API Key', help='Odoo API key scoped to this branch (created in Gateway dashboard). Keep secret.', copy=False)
    enabled = fields.Boolean(default=True)
    description = fields.Text()
    location = fields.Char()
    timezone = fields.Char(default='UTC')
    gateway_branch_id = fields.Char(string='Gateway Branch ID', help='Stable Gateway branch identity.', copy=False)

    destination_ids = fields.One2many('print_gateway.destination', 'branch_id', string='Destinations')
    printer_ids = fields.Many2many('print_gateway.printer', compute='_compute_printers', string='Printers', readonly=True)
    document_type_ids = fields.One2many('print_gateway.document_type', 'branch_id', string='Document Types')
    binding_ids = fields.One2many('print_gateway.printer_binding', 'branch_id', string='Printer Bindings')
    agent_ids = fields.One2many('print_gateway.agent', 'branch_id', string='Agents')

    agent_count = fields.Integer(compute='_compute_counts', string='Agents Online')
    printer_count = fields.Integer(compute='_compute_counts', string='Printers Total')
    last_sync_at = fields.Datetime(string='Last Sync At', readonly=True)
    last_sync_status = fields.Selection([
        ('success', 'Success'),
        ('failed', 'Failed'),
        ('partial', 'Partial'),
    ], string='Last Sync Status', readonly=True, copy=False)
    last_sync_error = fields.Text(string='Last Sync Error', readonly=True, copy=False)
    last_successful_sync_at = fields.Datetime(string='Last Successful Sync', readonly=True, copy=False)

    _name_company_unique = models.Constraint(
        'unique(name, company_id)',
        'Branch name must be unique per company',
    )

    @api.model_create_multi
    def create(self, vals_list):
        """Create branch configuration records using Odoo 19's multi-create API."""
        normalized = []
        for incoming in vals_list:
            vals = dict(incoming)
            if 'company_id' not in vals:
                vals['company_id'] = self.env.company.id
            # Prevent users from creating branches in other companies.
            if vals.get('company_id') and vals['company_id'] != self.env.company.id:
                from odoo.exceptions import AccessError
                raise AccessError(_("You cannot create branches outside your company."))
            normalized.append(vals)
        return super().create(normalized)

    def write(self, vals):
        """Prevent company change and validate access."""
        if 'company_id' in vals:
            for rec in self:
                if rec.company_id.id != vals['company_id']:
                    from odoo.exceptions import AccessError
                    raise AccessError(_("You cannot change a branch's company. Please create a new branch instead."))
        self._check_company_access()
        return super().write(vals)

    def _check_company_access(self):
        """Verify user has access to branch's company."""
        for rec in self:
            if rec.company_id and rec.company_id.id not in self.env.user.company_ids.ids:
                from odoo.exceptions import AccessError
                raise AccessError(_("You do not have access to branch %s's company.") % rec.name)

    @api.depends('agent_ids', 'agent_ids.status')
    def _compute_counts(self):
        for rec in self:
            rec.agent_count = len(rec.agent_ids.filtered(lambda a: a.status == 'online'))
            rec.printer_count = self.env['print_gateway.printer'].search_count([('agent_id.branch_id', '=', rec.id)])

    @api.depends('agent_ids', 'agent_ids.printer_ids')
    def _compute_printers(self):
        Printer = self.env['print_gateway.printer']
        for rec in self:
            rec.printer_ids = Printer.search([('agent_id.branch_id', '=', rec.id)])

    def unlink(self):
        raise ValidationError(_('Branches are lifecycle/configuration roots and cannot be physically deleted. Disable the branch or decommission it explicitly.'))

    def _gateway_headers(self):
        if not self.gateway_api_key:
            raise ValidationError(_('Gateway API key not configured for branch %s') % self.name)
        return {
            'Authorization': f'Bearer {self.gateway_api_key}',
            'Content-Type': 'application/json',
        }

    def _gateway_base(self):
        if not self.gateway_url:
            raise ValidationError(_('Gateway URL not configured for branch %s') % self.name)
        return self.gateway_url.rstrip('/')

    def cron_retry_pending_print_jobs(self):
        """Retry persisted Odoo print operations that have no Gateway job id.

        The persisted idempotency_key is the logical operation identity, so a
        process restart can retry safely without minting a second operation.
        A new manual print creates a separate print_job row/key.
        """
        Job = self.env['print_gateway.print_job']
        pending = Job.search([('gateway_job_id', '=', False), ('status', '=', 'queued')], order='id asc', limit=100)
        retried = 0
        for job in pending:
            try:
                job.action_submit_pending()
                retried += 1
            except Exception as exc:
                _logger.warning("Pending Gateway print retry failed for operation %s: %s", job.id, str(exc))
        return retried

    def action_test_connection(self):
        self.ensure_one()
        try:
            url = f"{self._gateway_base()}/api/health"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {'title': _('Connection OK'), 'message': _('Gateway reachable'), 'type': 'success'},
                }
            raise ValidationError(_('Gateway returned %s: %s') % (resp.status_code, resp.text[:200]))
        except requests.RequestException as e:
            raise ValidationError(_('Cannot reach Gateway: %s') % str(e))

    def _gateway_get_json(self, url, headers, params=None, timeout=10):
        """GET a JSON Gateway endpoint with strict transport semantics."""
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            raise ValidationError(_('Gateway request failed: %s') % str(exc))
        if not 200 <= resp.status_code < 300:
            raise ValidationError(_('Gateway returned HTTP %s: %s') % (resp.status_code, self._format_sync_error(resp)))
        try:
            body = resp.json()
        except ValueError as exc:
            raise ValidationError(_('Gateway returned malformed JSON: %s') % str(exc))
        if not isinstance(body, (list, dict)):
            raise ValidationError(_('Gateway returned an invalid JSON payload'))
        return body

    def action_sync_from_gateway(self):
        """Pull runtime state in dependency order: Agents, then Printers."""
        errors = []
        for branch in self:
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                gateway_branch_id = str(branch.gateway_branch_id or branch.id)

                agents_data = branch._gateway_get_json(
                    f"{base}/api/odoo/agents",
                    headers,
                    params={'branchId': gateway_branch_id},
                )
                if not isinstance(agents_data, list):
                    raise ValidationError(_('Agents endpoint must return an array'))

                Agent = branch.env['print_gateway.agent']
                with branch.env.cr.savepoint():
                    for ag in agents_data:
                        gateway_id = ag.get('id')
                        if not isinstance(gateway_id, str) or not gateway_id.strip():
                            raise ValidationError(_('Agents endpoint returned an invalid agent id'))
                        existing = Agent.search([('gateway_agent_id', '=', gateway_id)], limit=1)
                        if ag.get('lifecycle') not in ('active', 'disabled', 'retired'):
                            raise ValidationError(_('Agent %s has missing or invalid lifecycle') % gateway_id)
                        vals = {
                            'branch_id': branch.id,
                            'gateway_agent_id': gateway_id,
                            'name': (ag.get('name') or gateway_id)[:255],
                            'status': ag.get('status') or 'unknown',
                            'lifecycle': ag.get('lifecycle'),
                            'last_seen_at': ag.get('lastSeenAt') or False,
                        }
                        if existing:
                            if existing.branch_id != branch:
                                raise ValidationError(_('Agent %s belongs to another Odoo branch') % gateway_id)
                            existing.write(vals)
                        else:
                            Agent.create(vals)

                printer_error = None
                try:
                    printers_data = branch._gateway_get_json(
                        f"{base}/api/odoo/printers",
                        headers,
                        params={'branchId': gateway_branch_id},
                    )
                    if not isinstance(printers_data, list):
                        raise ValidationError(_('Printers endpoint must return an array'))
                    Printer = branch.env['print_gateway.printer']
                    for pr in printers_data:
                        printer_id = pr.get('id')
                        agent_id = pr.get('agentId')
                        if not isinstance(printer_id, str) or not printer_id.strip():
                            raise ValidationError(_('Printers endpoint returned an invalid printer id'))
                        if not isinstance(agent_id, str) or not agent_id.strip():
                            raise ValidationError(_('Printer %s has no owning agent') % printer_id)
                        agent = Agent.search([('gateway_agent_id', '=', agent_id)], limit=1)
                        if not agent:
                            raise ValidationError(_('Printer %s references an agent not present in the synchronized branch') % printer_id)
                        if agent.branch_id != branch:
                            raise ValidationError(_('Printer %s agent belongs to another branch') % printer_id)
                        existing = Printer.search([('gateway_printer_id', '=', printer_id)], limit=1)
                        if pr.get('printerType') not in ('physical', 'virtual', 'redirected'):
                            raise ValidationError(_('Printer %s has missing or invalid printerType') % printer_id)
                        if pr.get('deviceClass') not in ('thermal', 'laser', 'inkjet', 'label', 'other', 'unknown'):
                            raise ValidationError(_('Printer %s has missing or invalid deviceClass') % printer_id)
                        if pr.get('connectionType') not in ('network', 'usb', 'spooler', 'ipp', 'ipps'):
                            raise ValidationError(_('Printer %s has missing or invalid connectionType') % printer_id)
                        if pr.get('protocol') not in ('raw', 'escpos', 'ipp', 'ipps', 'spooler'):
                            raise ValidationError(_('Printer %s has missing or invalid protocol') % printer_id)
                        if pr.get('lifecycle') not in ('active', 'disabled', 'retired'):
                            raise ValidationError(_('Printer %s has missing or invalid lifecycle') % printer_id)
                        vals = {
                            'agent_id': agent.id,
                            'gateway_printer_id': printer_id,
                            'name': pr.get('name') or printer_id,
                            'printer_type': pr.get('printerType'),
                            'device_class': pr.get('deviceClass'),
                            'connection_type': pr.get('connectionType'),
                            'protocol': pr.get('protocol'),
                            'status': pr.get('status') or 'unknown',
                            'lifecycle': pr.get('lifecycle'),
                        }
                        cfg = pr.get('config') or {}
                        vals.update({
                            'ip_address': cfg.get('ip'),
                            'port': cfg.get('port'),
                            'spooler_name': cfg.get('spooler_name'),
                        })
                        if existing:
                            if existing.agent_id.branch_id != branch:
                                raise ValidationError(_('Printer %s belongs to another branch') % printer_id)
                            existing.write(vals)
                        else:
                            Printer.create(vals)
                except Exception as exc:
                    printer_error = str(exc)

                completed = fields.Datetime.now()
                if printer_error: