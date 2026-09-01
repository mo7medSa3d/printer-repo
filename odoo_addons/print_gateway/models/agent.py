# -*- coding: utf-8 -*-
from odoo import models, fields, api

class PrintGatewayAgent(models.Model):
    _name = 'print_gateway.agent'
    _description = 'Print Gateway Agent'
    _order = 'name'

    gateway_agent_id = fields.Char(string='Gateway Agent ID', required=True)
    name = fields.Char(required=True)
    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='cascade')
    status = fields.Selection([
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('unknown', 'Unknown'),
    ], default='unknown')
    last_seen_at = fields.Datetime(readonly=True)
    hostname = fields.Char()
    os = fields.Char(string='OS')

    printer_ids = fields.One2many('print_gateway.printer', 'gateway_agent_id', string='Printers', compute='_compute_printers', readonly=True)

    _sql_constraints = [
        ('gateway_agent_id_branch_unique', 'unique(gateway_agent_id, branch_id)', 'Agent ID must be unique per branch'),
    ]

    @api.depends('gateway_agent_id')
    def _compute_printers(self):
        for rec in self:
            rec.printer_ids = self.env['print_gateway.printer'].search([('gateway_agent_id', '=', rec.gateway_agent_id)])

    def action_sync_status(self):
        for agent in self:
            agent.branch_id.action_sync_from_gateway()
        return True
