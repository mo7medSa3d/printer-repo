# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError


class PrintGatewayAgent(models.Model):
    _name = 'print_gateway.agent'
    _description = 'Print Gateway Agent'
    _order = 'name'

    gateway_agent_id = fields.Char(string='Gateway Agent ID', required=True)
    name = fields.Char(required=True)
    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='restrict', readonly=True)
    status = fields.Selection([
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('unknown', 'Unknown'),
    ], default='unknown')
    lifecycle = fields.Selection([
        ('active', 'Active'), ('disabled', 'Disabled'), ('retired', 'Retired')
    ], default='active', required=True, readonly=True)
    last_seen_at = fields.Datetime(readonly=True)
    hostname = fields.Char()
    os = fields.Char(string='OS')
    printer_ids = fields.One2many('print_gateway.printer', 'agent_id', string='Printers', readonly=True)

    _gateway_agent_id_unique = models.Constraint(
        'UNIQUE(gateway_agent_id)',
        'Agent ID must be globally unique',
    )

    def write(self, vals):
        if 'lifecycle' in vals:
            for rec in self:
                if rec.lifecycle == 'retired' and vals['lifecycle'] != 'retired':
                    raise ValidationError(_('Retired agents are terminal; create/re-pair a new agent identity instead.'))
                if vals['lifecycle'] not in ('active', 'disabled', 'retired'):
                    raise ValidationError(_('Invalid agent lifecycle state.'))
        if 'branch_id' in vals:
            for rec in self:
                if rec.branch_id.id != vals['branch_id']:
                    raise ValidationError(_('Agent branch ownership is immutable; retire and re-pair the agent in the new branch.'))
        return super().write(vals)

    def unlink(self):
        raise ValidationError(_('Agents cannot be physically deleted. Disable or retire the agent to preserve history.'))

    def action_sync_status(self):
        for agent in self:
            agent.branch_id.action_sync_from_gateway()
        return True
