# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import requests
import logging

_logger = logging.getLogger(__name__)


class PrintGatewayPrinter(models.Model):
    _name = 'print_gateway.printer'
    _description = 'Print Gateway Printer'
    _order = 'name'

    gateway_printer_id = fields.Char(string='Gateway Printer ID', required=True, help='ID in Gateway, e.g., printer_xxx')
    name = fields.Char(required=True)
    agent_id = fields.Many2one('print_gateway.agent', required=True, ondelete='restrict')
    branch_id = fields.Many2one('print_gateway.branch', related='agent_id.branch_id', store=True, readonly=True)
    printer_type = fields.Selection([('physical', 'Physical'), ('virtual', 'Virtual'), ('redirected', 'Redirected')], default='physical', string='Printer Type', readonly=True)
    device_class = fields.Selection([('thermal', 'Thermal'), ('laser', 'Laser'), ('inkjet', 'Inkjet'), ('label', 'Label'), ('other', 'Other'), ('unknown', 'Unknown')], default='unknown', string='Device Class', readonly=True)
    connection_type = fields.Selection([('network', 'Network'), ('usb', 'USB'), ('spooler', 'Windows Spooler'), ('ipp', 'IPP'), ('ipps', 'IPPS')], default='network', string='Connection Type')
    protocol = fields.Selection([('raw', 'Raw Binary'), ('escpos', 'ESC/POS'), ('ipp', 'IPP Protocol'), ('ipps', 'IPPS Protocol'), ('spooler', 'Windows Spooler')], default='raw', string='Protocol')
    status = fields.Selection([('online', 'Online'), ('offline', 'Offline'), ('busy', 'Busy'), ('error', 'Error'), ('unknown', 'Unknown')], default='unknown')
    ip_address = fields.Char(help='Network IP if TCP')
    port = fields.Integer(help='Network port if TCP')
    usb_serial = fields.Char(help='USB serial')
    spooler_name = fields.Char(help='Windows spooler printer name')
    lifecycle = fields.Selection([('active', 'Active'), ('disabled', 'Disabled'), ('retired', 'Retired')], default='active', required=True, readonly=True)
    binding_ids = fields.One2many('print_gateway.printer_binding', 'printer_id', string='Bindings')
    binding_count = fields.Integer(compute='_compute_binding_count', string='Binding Count')
    destination_ids = fields.Many2many('print_gateway.destination', compute='_compute_destinations', string='Assigned Destinations')
    last_seen_at = fields.Datetime(readonly=True)

    _gateway_printer_id_unique = models.Constraint(
        'UNIQUE(gateway_printer_id)',
        'Printer ID must be globally unique',
    )

    @api.constrains('agent_id')
    def _check_agent_branch(self):
        for rec in self:
            if not rec.agent_id:
                raise ValidationError(_('Printer must have an owning agent'))
            if rec.branch_id and rec.branch_id != rec.agent_id.branch_id:
                raise ValidationError(_('Printer branch is derived from agent and cannot diverge'))

    @api.depends('binding_ids')
    def _compute_binding_count(self):
        for rec in self:
            rec.binding_count = len(rec.binding_ids)

    @api.depends('binding_ids', 'binding_ids.destination_id')
    def _compute_destinations(self):
        for rec in self:
            rec.destination_ids = rec.binding_ids.mapped('destination_id')

    def write(self, vals):
        if 'lifecycle' in vals:
            for rec in self:
                if rec.lifecycle == 'retired' and vals['lifecycle'] != 'retired':
                    raise ValidationError(_('Retired printers are terminal; provision a new printer identity instead.'))
                if vals['lifecycle'] not in ('active', 'disabled', 'retired'):
                    raise ValidationError(_('Invalid printer lifecycle state.'))
                if rec.lifecycle == 'active' and vals['lifecycle'] not in ('active', 'disabled', 'retired'):
                    raise ValidationError(_('Invalid printer lifecycle transition.'))
                if rec.lifecycle == 'disabled' and vals['lifecycle'] not in ('disabled', 'active', 'retired'):
                    raise ValidationError(_('Invalid printer lifecycle transition.'))
        if 'agent_id' in vals:
            for rec in self:
                if rec.agent_id.id and rec.agent_id.id != vals['agent_id']:
                    raise ValidationError(_('Printer ownership is immutable; retire and provision it under a new agent.'))
        return super().write(vals)

    def unlink(self):
        raise ValidationError(_('Printers cannot be physically deleted. Disable or retire the printer to preserve history.'))

    def action_sync_from_gateway(self):
        for printer in self:
            branch = printer.agent_id.branch_id
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                resp = requests.get(f"{base}/api/odoo/printers", params={'branchId': str(branch.gateway_branch_id or branch.id)}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for pr in resp.json():
                        if pr.get('id') == printer.gateway_printer_id:
                            printer.write({'status': pr.get('status') or 'unknown', 'lifecycle': pr.get('lifecycle') or 'active'})
                            break
            except Exception as e:
                _logger.warning("Printer sync failed for %s: %s", printer.name, str(e))

    def action_test_print(self):
        self.ensure_one()
        branch = self.branch_id
        headers = branch._gateway_headers()
        base = branch._gateway_base()
        resp = requests.post(f"{base}/api/printers/{self.gateway_printer_id}/test-print", headers=headers, timeout=15)
        if resp.status_code not in (200, 201):
            raise ValidationError(_('Test print failed %s: %s') % (resp.status_code, resp.text[:500]))
        try:
            data = resp.json()
        except ValueError as exc:
            raise ValidationError(_('Gateway returned malformed JSON for test print')) from exc

        job_id = data.get('jobId') or data.get('id')
        if not job_id:
            raise ValidationError(_('Gateway accepted the test print but returned no job id'))

        remote_status = data.get('status') or 'queued'
        if remote_status == 'completed':
            remote_status = 'success'
        if remote_status not in ('queued', 'claimed', 'printing', 'success', 'failed', 'expired'):
            remote_status = 'queued'

        self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'gateway_job_id': job_id,
            'printer_id': self.id,
            'agent_id': self.agent_id.id,
            'status': remote_status,
            'document_type': 'test',
            'payload': 'test print',
            'requested_by': 'odoo-test',
        })
        return {'type': 'ir.actions.client', 'tag': 'display_notification', 'params': {'title': _('Test Print Queued'), 'message': _('Job %s created') % job_id, 'type': 'success'}}
