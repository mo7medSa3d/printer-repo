# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError


class PrintGatewayReportMapping(models.Model):
    _name = 'print_gateway.report_mapping'
    _description = 'Report to Document Type Mapping'
    _order = 'priority, id'

    name = fields.Char(string='Mapping Name', compute='_compute_name', store=True, readonly=False)
    active = fields.Boolean(default=True)

    # Report identification - priority: report_id > report_xml_id > report_name > model
    report_id = fields.Many2one(
        'ir.actions.report',
        string='Report',
        help='Odoo report action. If set, takes highest priority.',
    )
    report_xml_id = fields.Char(
        string='Report XML ID',
        help='e.g., sale.action_report_saleorder, account.account_invoices. Used when report_id not set.',
    )
    model_name = fields.Char(
        string='Model',
        help='e.g., sale.order, account.move. Used as fallback mapping.',
    )
    report_name = fields.Char(
        string='Report Name',
        help='Technical report name, e.g., sale.report_saleorder_document.',
    )

    # Document type mapping
    document_type_id = fields.Many2one(
        'print_gateway.document_type',
        string='Document Type',
        help='Maps to print_gateway.document_type. If empty, uses document_type_name.',
    )
    document_type_name = fields.Char(
        string='Document Type Name',
        help='Fallback string like quotation, invoice, delivery, purchase_order, receipt, label. Lowercase.',
    )

    # Routing - if empty, will be determined dynamically from record/branch
    branch_id = fields.Many2one(
        'print_gateway.branch',
        string='Branch',
        help='If set, forces this branch. Otherwise determined from record/company.',
    )
    destination_id = fields.Many2one(
        'print_gateway.destination',
        string='Destination',
        help='If set, forces this destination. Otherwise determined from branch/record.',
    )

    gateway_enabled = fields.Boolean(
        string='Gateway Enabled',
        default=True,
        help='If enabled, this report will be routed through Print Gateway. Otherwise normal Odoo printing.',
    )
    # QWeb report mappings generate PDF. Keeping this field preserves the
    # transport contract used by the report integration while deliberately
    # preventing a false ESC/POS/RAW configuration.
    payload_type = fields.Selection(
        [('pdf', 'PDF (application/pdf)')],
        default='pdf',
        string='Payload Type',
        required=True,
        help='PDF reports remain application/pdf. PDF is never relabeled as raw. Use the direct print-job API for RAW/ESC-POS data.',
    )
    priority = fields.Integer(
        default=10,
        help='Lower number = higher priority when multiple mappings match.',
    )

    _sql_constraints = [
        ('priority_unique', 'unique(report_id, priority)', 'Priority must be unique per exact report.'),
    ]

    @api.depends('report_id', 'report_xml_id', 'model_name', 'report_name', 'document_type_id', 'document_type_name')
    def _compute_name(self):
        for rec in self:
            parts = []
            if rec.report_id:
                parts.append(rec.report_id.name or rec.report_id.report_name or str(rec.report_id.id))
            elif rec.report_xml_id:
                parts.append(rec.report_xml_id)
            elif rec.report_name:
                parts.append(rec.report_name)
            elif rec.model_name:
                parts.append(rec.model_name)
            else:
                parts.append('Mapping')

            dt = rec.document_type_id.name if rec.document_type_id else rec.document_type_name
            if dt:
                parts.append(f'-> {dt}')
            rec.name = ' '.join(parts)

    @api.constrains('report_id', 'report_xml_id', 'report_name', 'model_name')
    def _check_at_least_one_identifier(self):
        for rec in self:
            if not rec.report_id and not rec.report_xml_id and not rec.report_name and not rec.model_name:
                raise ValidationError(_(
                    'At least one of Report, Report XML ID, Report Name, or Model must be set.'
                ))

    @api.constrains('branch_id', 'destination_id')
    def _check_destination_branch(self):
        for rec in self:
            if rec.destination_id and rec.branch_id and rec.destination_id.branch_id != rec.branch_id:
                raise ValidationError(_(
                    'Destination %s must belong to the selected branch %s.'
                ) % (rec.destination_id.display_name, rec.branch_id.display_name))

    @api.model
    def get_mapping_for_report(self, report):
        """Find the best active Gateway mapping for a report.

        Precedence is exact report > external XML ID > technical report name > model.
        Within the same identifier class, priority asc and id asc make selection deterministic.
        """
        if not report:
            return False

        order = 'priority asc, id asc'

        mapping = self.search([
            ('report_id', '=', report.id),
            ('active', '=', True),
            ('gateway_enabled', '=', True),
        ], order=order, limit=1)
        if mapping:
            return mapping

        try:
            xml_id = report.get_external_id().get(report.id)
            if xml_id:
                mapping = self.search([
                    ('report_xml_id', '=', xml_id),
                    ('active', '=', True),
                    ('gateway_enabled', '=', True),
                ], order=order, limit=1)
                if mapping:
                    return mapping
        except Exception:
            # External-id lookup is a convenience fallback; report routing must not fail
            # merely because an external id is unavailable.
            pass

        if report.report_name:
            mapping = self.search([
                ('report_name', '=', report.report_name),
                ('active', '=', True),
                ('gateway_enabled', '=', True),
            ], order=order, limit=1)
            if mapping:
                return mapping

        if report.model:
            mapping = self.search([
                ('model_name', '=', report.model),
                ('active', '=', True),
                ('gateway_enabled', '=', True),
            ], order=order, limit=1)
            if mapping:
                return mapping

        return False

    @api.model
    def get_mapping_for_model(self, model_name, report_name=None):
        """Helper for tests/tools: find an active mapping by report name then model."""
        domain = [('active', '=', True), ('gateway_enabled', '=', True)]
        order = 'priority asc, id asc'
        if report_name:
            mapping = self.search([('report_name', '=', report_name)] + domain, order=order, limit=1)
            if mapping:
                return mapping
        if model_name:
            mapping = self.search([('model_name', '=', model_name)] + domain, order=order, limit=1)
            if mapping:
                return mapping
        return False
