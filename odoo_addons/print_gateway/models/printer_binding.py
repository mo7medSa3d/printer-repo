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
    printer_id = fields.Many2one(
        'print_gateway.printer', required=True, ondelete='restrict',
        domain="[('agent_id.branch_id', '=', branch_id)]")
    # Convenience/read-only view of the ownership chain: printer -> agent.
    printer_agent_id = fields.Many2one(
        'print_gateway.agent', string='Printer Agent',
        related='printer_id.agent_id', store=False, readonly=True)
    priority = fields.Integer(default=1, help='1=highest priority, lower number tried first; fallback chain')
    enabled = fields.Boolean(default=True)
    gateway_binding_id = fields.Char(string='Gateway Binding ID', copy=False)
    config_override = fields.Text(help='JSON config overrides')
    notes = fields.Text()

    _sql_constraints = [
        ('priority_branch_dest_doctype_unique', 'unique(branch_id, destination_id, document_type, priority)', 'Priority must be unique per branch/destination/document_type'),
    ]

    @api.constrains('branch_id', 'destination_id', 'printer_id', 'document_type_id')
    def _check_branch_consistency(self):
        """A binding is a branch-scoped routing rule.

        ``branch_id`` is KEPT on bindings on purpose: routing looks up
        (branch, destination, document type) and a binding is meaningful only
        inside one branch. It is routing scope, not printer ownership.

        It must nevertheless agree with the printer's real owner, which is
        derived as printer -> agent -> branch. Binding in Branch A pointing at a
        printer whose agent is in Branch B is refused outright.
        """
        for rec in self:
            if rec.destination_id.branch_id != rec.branch_id:
                raise ValidationError(_('Destination must belong to the same branch as binding'))
            if not rec.printer_id.agent_id:
                raise ValidationError(_(
                    'Printer %s has no agent, so it has no branch; a binding cannot route to it.'
                ) % rec.printer_id.display_name)
            printer_branch = rec.printer_id.agent_id.branch_id
            if printer_branch != rec.branch_id:
                raise ValidationError(_(
                    'Cross-branch binding refused: binding is in branch %s but printer %s belongs to '
                    'branch %s through its agent %s.'
                ) % (
                    rec.branch_id.display_name,
                    rec.printer_id.display_name,
                    printer_branch.display_name or 'none',
                    rec.printer_id.agent_id.display_name,
                ))
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
