# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError

class PrintGatewayPrinterBinding(models.Model):
    _name = 'print_gateway.printer_binding'
    _description = 'Printer Binding (Destination + Document Type -> Printer)'
    _order = 'priority, id'

    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='cascade')
    destination_id = fields.Many2one('print_gateway.destination', required=True, ondelete='cascade')
    document_type_id = fields.Many2one('print_gateway.document_type', ondelete='cascade', string='Document Type')
    document_type = fields.Char(string='Document Type (legacy string)', help='For simple string documentType like receipt/invoice/label/order')
    printer_id = fields.Many2one('print_gateway.printer', required=True, ondelete='restrict')
    priority = fields.Integer(default=1, help='1=highest priority, lower number tried first; fallback chain')
    enabled = fields.Boolean(default=True)
    gateway_binding_id = fields.Char(string='Gateway Binding ID', copy=False)
    config_override = fields.Text(help='JSON config overrides')
    notes = fields.Text()

    _sql_constraints = [
        ('priority_branch_dest_doctype_unique', 'unique(branch_id, destination_id, document_type, priority)', 'Priority must be unique per branch/destination/document_type'),
    ]

    @api.constrains('branch_id', 'destination_id', 'printer_id')
    def _check_branch_consistency(self):
        for rec in self:
            if rec.destination_id.branch_id != rec.branch_id:
                raise ValidationError(_('Destination must belong to the same branch as binding'))
            if rec.printer_id.branch_id != rec.branch_id:
                raise ValidationError(_('Printer must belong to the same branch as binding (cross-branch bindings forbidden)'))
            if rec.document_type_id and rec.document_type_id.branch_id != rec.branch_id:
                raise ValidationError(_('Document Type must belong to same branch'))

    @api.model
    def create(self, vals):
        rec = super().create(vals)
        # Ensure gateway sync can be triggered; idempotent sync via action
        return rec

    def name_get(self):
        result = []
        for rec in self:
            doctype = rec.document_type_id.name if rec.document_type_id else (rec.document_type or '*')
            result.append((rec.id, f'{rec.destination_id.name} + {doctype} -> {rec.printer_id.name} (p{rec.priority})'))
        return result
