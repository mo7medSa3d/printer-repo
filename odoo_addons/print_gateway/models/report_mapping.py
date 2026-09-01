# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError

class PrintGatewayReportMapping(models.Model):
    _name = 'print_gateway.report_mapping'
    _description = 'Report to Document Type Mapping'
    _order = 'priority, id'

    name = fields.Char(string='Mapping Name', compute='_compute_name', store=True, readonly=False)
    active = fields.Boolean(default=True)

    # Report identification - priority: report_id > report_xml_id > model + report_name
    report_id = fields.Many2one('ir.actions.report', string='Report', help='Odoo report action. If set, takes highest priority.')
    report_xml_id = fields.Char(string='Report XML ID', help='e.g., sale.action_report_saleorder, account.account_invoices. Used when report_id not set.')
    model_name = fields.Char(string='Model', help='e.g., sale.order, account.move. Used as fallback mapping.')
    report_name = fields.Char(string='Report Name', help='Technical report name, e.g., sale.report_saleorder_document')

    # Document type mapping
    document_type_id = fields.Many2one('print_gateway.document_type', string='Document Type', help='Maps to print_gateway.document_type. If empty, uses document_type_name.')
    document_type_name = fields.Char(string='Document Type Name', help='Fallback string like quotation, invoice, delivery, purchase_order, receipt, label. Lowercase.')
    
    # Routing - if empty, will be determined dynamically from record/branch
    branch_id = fields.Many2one('print_gateway.branch', string='Branch', help='If set, forces this branch. Otherwise determined from record/company.')
    destination_id = fields.Many2one('print_gateway.destination', string='Destination', help='If set, forces this destination. Otherwise determined from branch/record.')
    
    # Gateway enabled for this report
    gateway_enabled = fields.Boolean(string='Gateway Enabled', default=True, help='If enabled, this report will be routed through Print Gateway. Otherwise normal Odoo printing.')
    
    # Payload type - how to generate payload
    payload_type = fields.Selection([
        ('pdf', 'PDF (render report as PDF)'),
        ('raw', 'Raw (send PDF bytes as raw)'),
        ('escpos', 'ESC/POS (for thermal printers, will try to convert)'),
    ], default='pdf', string='Payload Type', required=True, help='PDF will render the QWeb PDF and send as base64 raw. ESC/POS for thermal.')

    priority = fields.Integer(default=10, help='Lower number = higher priority when multiple mappings match')

    # Fallback behavior
    fallback_to_normal = fields.Boolean(default=True, string='Fallback to Normal', help='If Gateway fails, fallback to normal Odoo download/print instead of raising error.')

    _sql_constraints = [
        ('priority_unique', 'unique(report_id, priority)', 'Priority must be unique per report'),
    ]

    @api.depends('report_id', 'report_xml_id', 'model_name', 'document_type_id', 'document_type_name')
    def _compute_name(self):
        for rec in self:
            parts = []
            if rec.report_id:
                parts.append(rec.report_id.name or rec.report_id.report_name or str(rec.report_id.id))
            elif rec.report_xml_id:
                parts.append(rec.report_xml_id)
            elif rec.model_name:
                parts.append(rec.model_name)
            else:
                parts.append('Mapping')
            
            dt = rec.document_type_id.name if rec.document_type_id else rec.document_type_name
            if dt:
                parts.append(f"-> {dt}")
            rec.name = " ".join(parts)

    @api.constrains('report_id', 'report_xml_id', 'model_name')
    def _check_at_least_one_identifier(self):
        for rec in self:
            if not rec.report_id and not rec.report_xml_id and not rec.model_name:
                raise ValidationError(_('At least one of Report, Report XML ID, or Model must be set.'))

    @api.model
    def get_mapping_for_report(self, report):
        """Find best mapping for a given ir.actions.report record.
        Priority: report_id exact match > report_xml_id > model_name > report_name
        Returns the highest priority (lowest number) match or False.
        """
        if not report:
            return False
        
        # Try exact report_id match first
        mapping = self.search([('report_id', '=', report.id), ('active', '=', True), ('gateway_enabled', '=', True)], order='priority asc', limit=1)
        if mapping:
            return mapping
        
        # Try XML ID - need to find xml id for report
        try:
            xml_id = report.get_external_id().get(report.id)
            if xml_id:
                mapping = self.search([('report_xml_id', '=', xml_id), ('active', '=', True), ('gateway_enabled', '=', True)], order='priority asc', limit=1)
                if mapping:
                    return mapping
        except Exception:
            pass
        
        # Try report_name
        if report.report_name:
            mapping = self.search([('report_name', '=', report.report_name), ('active', '=', True), ('gateway_enabled', '=', True)], order='priority asc', limit=1)
            if mapping:
                return mapping
        
        # Try model
        if report.model:
            mapping = self.search([('model_name', '=', report.model), ('active', '=', True), ('gateway_enabled', '=', True)], order='priority asc', limit=1)
            if mapping:
                return mapping
        
        return False

    @api.model
    def get_mapping_for_model(self, model_name, report_name=None):
        """Helper for testing: find mapping by model/report_name"""
        domain = [('active', '=', True), ('gateway_enabled', '=', True)]
        if report_name:
            mapping = self.search([('report_name', '=', report_name)] + domain, order='priority asc', limit=1)
            if mapping:
                return mapping
        if model_name:
            mapping = self.search([('model_name', '=', model_name)] + domain, order='priority asc', limit=1)
            if mapping:
                return mapping
        return False
