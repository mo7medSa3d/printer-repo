# -*- coding: utf-8 -*-
from odoo import models, fields, api


class PrintGatewayDestination(models.Model):
    _name = 'print_gateway.destination'
    _description = 'Print Gateway Destination'
    _order = 'name'

    name = fields.Char(required=True, help='e.g., POS 1, Kitchen 1, Warehouse')
    destination_type = fields.Selection([
        ('pos', 'POS Terminal'),
        ('kitchen', 'Kitchen'),
        ('warehouse', 'Warehouse'),
        ('office', 'Office'),
        ('other', 'Other'),
    ], required=True, default='pos', string='Type')

    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='restrict', string='Branch')
    description = fields.Text()
    zone = fields.Char(help='Physical zone within branch')
    enabled = fields.Boolean(default=True)
    gateway_destination_id = fields.Char(string='Gateway Destination ID', copy=False, help='ID in Gateway DB; if empty, sync will create')

    binding_ids = fields.One2many('print_gateway.printer_binding', 'destination_id', string='Printer Bindings')

    _name_branch_unique = models.Constraint(
        'UNIQUE(name, branch_id)',
        'Destination name must be unique per branch',
    )

    # NOTE (audit #19): routing is exclusively the Gateway's responsibility.
    # This model previously carried a partial re-implementation
    # (``get_printer_for_doctype``) that diverged from the gateway:
    # case-sensitive document-type matching and a silent fallback to ANY
    # enabled binding (the gateway is case/whitespace-insensitive and
    # returns NO_ROUTE instead). The helper had no callers and was removed
    # so the routing rules (trim + lower, exact match first, priority, no
    # cross-doctype fallback) exist in exactly one place:
    # ``src/lib/routing.ts`` (selectBestBinding / selectFallbackBindings),
    # pinned by ``tests/routing-doctype-parity.test.ts``.
