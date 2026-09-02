# -*- coding: utf-8 -*-
from odoo import models, fields, api


class PrintGatewayAgent(models.Model):
    """Mirror of a Gateway agent.

    The agent is the SOLE owner of branch context for its printers:

        Branch -> Agent -> Printer

    Moving an agent to another branch moves every printer it owns, because
    ``print_gateway.printer.branch_id`` is a stored *related* field on
    ``agent_id.branch_id``. There is no second place to update, and therefore
    no way to end up with an agent in Branch A owning a printer in Branch B.
    """

    _name = 'print_gateway.agent'
    _description = 'Print Gateway Agent'
    _order = 'name'

    gateway_agent_id = fields.Char(string='Gateway Agent ID', required=True, index=True)
    name = fields.Char(required=True)
    branch_id = fields.Many2one(
        'print_gateway.branch', required=True, ondelete='cascade',
        help='Branch this agent serves. Every printer registered by this agent belongs to '
             'this branch (Branch -> Agent -> Printer).')
    status = fields.Selection([
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('unknown', 'Unknown'),
    ], default='unknown')
    last_seen_at = fields.Datetime(readonly=True)
    hostname = fields.Char()
    os = fields.Char(string='OS')

    # A real one2many on the ownership column. This used to be a computed
    # search over a plain Char (`gateway_agent_id`), which could not express
    # ownership, could not cascade, and silently matched printers mirrored in
    # other branches.
    printer_ids = fields.One2many('print_gateway.printer', 'agent_id', string='Printers')
    printer_count = fields.Integer(compute='_compute_printer_count', string='Printers')

    # A Gateway agent id is globally unique in the Gateway and an agent lives in
    # exactly one branch, so uniqueness is global here too. The previous
    # per-branch uniqueness allowed the same runtime agent to be mirrored into
    # two branches at once — the duplicated-ownership bug this redesign removes.
    _sql_constraints = [
        ('gateway_agent_id_unique', 'unique(gateway_agent_id)',
         'This Gateway agent is already mirrored; an agent belongs to exactly one branch.'),
    ]

    @api.depends('printer_ids')
    def _compute_printer_count(self):
        for rec in self:
            rec.printer_count = len(rec.printer_ids)

    def action_sync_status(self):
        for agent in self:
            agent.branch_id.action_sync_from_gateway()
        return True
