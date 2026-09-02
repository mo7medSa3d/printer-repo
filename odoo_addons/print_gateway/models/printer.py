# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import requests
import logging

_logger = logging.getLogger(__name__)

class PrintGatewayPrinter(models.Model):
    """Mirror of a Gateway printer.

    Ownership model (identical to the Gateway):

        Branch -> Agent -> Printer

    The printer belongs to an Agent (``agent_id``); the Agent belongs to a
    Branch. ``branch_id`` here is a *related* field on ``agent_id.branch_id``:
    Odoo maintains it from the agent, it is readonly everywhere, and it can
    never disagree with the agent. It is stored ONLY so that record rules
    (``[('branch_id.company_id', '=', ...)]``), search, grouping and the
    ``branch.printer_ids`` one2many keep working in SQL — it is not a second
    source of truth and nothing may write it directly.
    """

    _name = 'print_gateway.printer'
    _description = 'Print Gateway Printer'
    _order = 'name'

    gateway_printer_id = fields.Char(string='Gateway Printer ID', required=True, help='ID in Gateway, e.g., printer_xxx')
    name = fields.Char(required=True)
    # The one and only ownership link. Deleting the agent removes its printers,
    # exactly as the Gateway does.
    agent_id = fields.Many2one(
        'print_gateway.agent', string='Agent', required=True, ondelete='cascade', index=True,
        help='Agent that owns this printer. The printer\'s branch is derived from this agent.')
    branch_id = fields.Many2one(
        'print_gateway.branch', string='Branch',
        related='agent_id.branch_id', store=True, readonly=True, index=True, ondelete='cascade',
        help='Derived from the printer\'s agent (Branch -> Agent -> Printer). Read-only: '
             'move the agent to another branch, or hand the printer to an agent in the '
             'target branch, to change it.')
    printer_type = fields.Selection([
        ('thermal', 'Thermal Receipt'),
        ('laser', 'Laser'),
        ('inkjet', 'Inkjet'),
        ('spooler', 'Windows Spooler / Network'),
        ('other', 'Other'),
        ('unknown', 'Unknown'),
    ], default='unknown', string='Printer Type')
    connection_type = fields.Selection([
        ('tcp', 'Network (TCP)'),
        ('usb', 'USB'),
        ('spooler', 'Windows Spooler'),
        ('ipp', 'IPP'),
        ('ipps', 'IPPS'),
        ('network', 'Network'),
    ], default='tcp', string='Connection Type')
    protocol = fields.Selection([
        ('raw', 'Raw Binary'),
        ('escpos', 'ESC/POS'),
        ('pcl', 'PCL'),
        ('ipp', 'IPP Protocol'),
        ('ipps', 'IPPS Protocol'),
        ('spooler', 'Windows Spooler'),
    ], default='raw', string='Protocol')
    status = fields.Selection([
        ('online', 'Online'),
        ('offline', 'Offline'),
        ('busy', 'Busy'),
        ('error', 'Error'),
        ('unknown', 'Unknown'),
    ], default='unknown')
    ip_address = fields.Char(help='Network IP if TCP')
    port = fields.Integer(help='Network port if TCP')
    usb_serial = fields.Char(help='USB serial')
    spooler_name = fields.Char(help='Windows spooler printer name')
    enabled = fields.Boolean(default=True)
    # Kept as the raw Gateway identifier for traceability and for sync
    # matching; it is a mirror of ``agent_id.gateway_agent_id``, not an
    # independent ownership pointer.
    gateway_agent_id = fields.Char(
        string='Gateway Agent ID', related='agent_id.gateway_agent_id', store=True, readonly=True)

    binding_ids = fields.One2many('print_gateway.printer_binding', 'printer_id', string='Bindings')
    binding_count = fields.Integer(compute='_compute_binding_count', string='Binding Count')
    destination_ids = fields.Many2many('print_gateway.destination', compute='_compute_destinations', string='Assigned Destinations')
    last_seen_at = fields.Datetime(readonly=True)

    # Gateway printer ids are globally unique in the Gateway, and a printer has
    # exactly one owning agent. Uniqueness is therefore global here too: the old
    # per-branch uniqueness allowed the SAME physical printer to be mirrored in
    # two branches at once, which is precisely the inconsistency this model
    # removes.
    _sql_constraints = [
        ('gateway_printer_id_unique', 'unique(gateway_printer_id)',
         'This Gateway printer is already mirrored; a printer belongs to exactly one agent (and therefore one branch).'),
    ]

    @api.constrains('agent_id')
    def _check_agent_branch(self):
        for rec in self:
            if not rec.agent_id:
                raise ValidationError(_('A printer must belong to an agent: its branch is derived through the agent.'))
            if not rec.agent_id.branch_id:
                raise ValidationError(_('Agent %s has no branch; assign the agent to a branch first.') % rec.agent_id.display_name)

    @api.depends('binding_ids')
    def _compute_binding_count(self):
        for rec in self:
            rec.binding_count = len(rec.binding_ids)

    @api.depends('binding_ids', 'binding_ids.destination_id')
    def _compute_destinations(self):
        for rec in self:
            rec.destination_ids = rec.binding_ids.mapped('destination_id')

    def action_sync_from_gateway(self):
        for printer in self:
            branch = printer.branch_id
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                # /api/printers/{id} is a manager-only endpoint; the Odoo
                # addon authenticates with a branch-scoped Odoo API key, so it
                # must use the documented /api/odoo/printers endpoint (which
                # accepts the Odoo key) and filter by printer id locally.
                resp = requests.get(
                    f"{base}/api/odoo/printers",
                    params={'branchId': str(branch.gateway_branch_id or branch.id)},
                    headers=headers, timeout=10)
                if resp.status_code == 200:
                    for pr in resp.json():
                        if pr.get('id') == printer.gateway_printer_id:
                            printer.write({
                                'status': pr.get('status') or 'unknown',
                                'enabled': pr.get('enabled', True),
                            })
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
        data = resp.json()
        job_id = data.get('jobId') or data.get('id')
        # Create tracking job
        self.env['print_gateway.print_job'].create({
            'branch_id': branch.id,
            'gateway_job_id': job_id,
            'printer_id': self.id,
            'status': 'queued',
            'document_type': 'test',
            'payload': 'test print',
        })
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {'title': _('Test Print Queued'), 'message': _('Job %s created') % job_id, 'type': 'success'},
        }
