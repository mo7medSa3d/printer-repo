# -*- coding: utf-8 -*-
from odoo import models, fields

class PrintGatewayDocumentType(models.Model):
    _name = 'print_gateway.document_type'
    _description = 'Print Gateway Document Type'
    _order = 'name'

    name = fields.Char(required=True, help='e.g., Receipt, Invoice, Label, Order')
    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='cascade')
    description = fields.Text()
    payload_hint = fields.Selection([
        ('raw', 'Raw Binary'),
        ('escpos', 'ESC/POS'),
        ('pcl', 'PCL'),
        ('ipp', 'IPP'),
        ('pdf', 'PDF'),
    ], string='Payload Hint')
    enabled = fields.Boolean(default=True)
    gateway_document_type_id = fields.Char(string='Gateway Document Type ID', copy=False)

    _sql_constraints = [
        ('name_branch_unique', 'unique(name, branch_id)', 'Document type must be unique per branch'),
    ]
