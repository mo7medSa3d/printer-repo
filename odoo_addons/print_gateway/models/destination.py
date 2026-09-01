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

    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='cascade', string='Branch')
    description = fields.Text()
    zone = fields.Char(help='Physical zone within branch')
    enabled = fields.Boolean(default=True)
    gateway_destination_id = fields.Char(string='Gateway Destination ID', copy=False, help='ID in Gateway DB; if empty, sync will create')

    binding_ids = fields.One2many('print_gateway.printer_binding', 'destination_id', string='Printer Bindings')

    _sql_constraints = [
        ('name_branch_unique', 'unique(name, branch_id)', 'Destination name must be unique per branch'),
    ]

    def get_printer_for_doctype(self, document_type_name):
        """Returns printer record for document type, respecting priority fallback."""
        self.ensure_one()
        bindings = self.binding_ids.filtered(lambda b: b.enabled and (not b.document_type or b.document_type == document_type_name or (b.document_type_id and b.document_type_id.name == document_type_name))).sorted('priority')
        if bindings:
            return bindings[0].printer_id
        # Fallback: any enabled binding sorted by priority
        fallback = self.binding_ids.filtered(lambda b: b.enabled).sorted('priority')
        return fallback[0].printer_id if fallback else False
