from odoo import models, fields, api, _
from odoo.exceptions import ValidationError


class PrintGatewayReportMapping(models.Model):
    _name = 'print_gateway.report_mapping'
    _description = 'Report to Document Type Mapping'
    _order = 'priority, id'

    name = fields.Char(string='Mapping Name', compute='_compute_name', store=True, readonly=False)
    active = fields.Boolean(default=True)
    report_id = fields.Many2one('ir.actions.report', string='Report', help='Odoo report action. If set, takes highest priority.')
    report_xml_id = fields.Char(string='Report XML ID', help='Technical fallback identifier.')
    model_name = fields.Char(string='Model', help='Technical fallback model identifier.')
    report_name = fields.Char(string='Report Name', help='Technical fallback report identifier.')

    document_type_id = fields.Many2one('print_gateway.document_type', string='Document Type')
    document_type_name = fields.Char(string='Document Type Name', help='Legacy fallback string.')
    branch_id = fields.Many2one('print_gateway.branch', string='Branch')
    destination_id = fields.Many2one('print_gateway.destination', string='Destination')

    # Odoo-native context selectors. A POS or warehouse operation can have its
    # own destination while a branch-wide report rule remains the fallback.
    pos_config_id = fields.Many2one(
        'pos.config',
        string='POS',
        help='Restrict this rule to a specific Odoo POS. Leave empty for branch-wide rules.',
    )
    picking_type_id = fields.Many2one(
        'stock.picking.type',
        string='Operation Type',
        help='Restrict this rule to a specific warehouse operation type.',
    )

    gateway_enabled = fields.Boolean(string='Gateway Enabled', default=True)
    payload_type = fields.Selection(
        [('pdf', 'PDF (application/pdf)')],
        default='pdf',
        string='Payload Type',
        required=True,
        help='QWeb reports remain PDF payloads. RAW/ESC/POS jobs use the direct print-job API.',
    )
    priority = fields.Integer(default=10, help='Lower number = higher priority within the same context scope.')

    _priority_unique = models.Constraint(
        'UNIQUE(report_id, priority, branch_id, pos_config_id, picking_type_id)',
        'Priority must be unique within the same report and print-rule scope.',
    )

    @api.depends(
        'report_id', 'report_xml_id', 'model_name', 'report_name',
        'document_type_id', 'document_type_name', 'pos_config_id', 'picking_type_id'
    )
    def _compute_name(self):
        for rec in self:
            if rec.report_id:
                parts = [rec.report_id.name or rec.report_id.report_name or str(rec.report_id.id)]
            elif rec.report_xml_id:
                parts = [rec.report_xml_id]
            elif rec.report_name:
                parts = [rec.report_name]
            elif rec.model_name:
                parts = [rec.model_name]
            else:
                parts = ['Mapping']

            context_name = rec.pos_config_id.display_name if rec.pos_config_id else rec.picking_type_id.display_name
            if context_name:
                parts.append(f'[{context_name}]')
            dt = rec.document_type_id.name if rec.document_type_id else rec.document_type_name
            if dt:
                parts.append(f'-> {dt}')
            rec.name = ' '.join(parts)

    @api.constrains('report_id', 'report_xml_id', 'report_name', 'model_name')
    def _check_at_least_one_identifier(self):
        for rec in self:
            if not rec.report_id and not rec.report_xml_id and not rec.report_name and not rec.model_name:
                raise ValidationError(_('At least one of Report, Report XML ID, Report Name, or Model must be set.'))

    @api.constrains('branch_id', 'destination_id', 'document_type_id', 'pos_config_id', 'picking_type_id')
    def _check_scope_consistency(self):
        for rec in self:
            if rec.destination_id and rec.branch_id and rec.destination_id.branch_id != rec.branch_id:
                raise ValidationError(_('Destination %s must belong to the selected branch %s.') % (rec.destination_id.display_name, rec.branch_id.display_name))
            if rec.document_type_id and rec.branch_id and rec.document_type_id.branch_id != rec.branch_id:
                raise ValidationError(_('Document Type %s must belong to the selected branch %s.') % (rec.document_type_id.display_name, rec.branch_id.display_name))

            if rec.pos_config_id and rec.picking_type_id:
                raise ValidationError(_('A print rule can target a POS or a warehouse operation type, not both.'))

            if rec.pos_config_id:
                if not rec.branch_id:
                    raise ValidationError(_('A POS-specific print rule must select a branch.'))
                if rec.pos_config_id.company_id and rec.pos_config_id.company_id != rec.branch_id.company_id:
                    raise ValidationError(_('POS %s belongs to another Odoo company/branch.') % rec.pos_config_id.display_name)

            if rec.picking_type_id:
                if not rec.branch_id:
                    raise ValidationError(_('An operation-type-specific print rule must select a branch.'))
                if rec.picking_type_id.company_id and rec.picking_type_id.company_id != rec.branch_id.company_id:
                    raise ValidationError(_('Operation Type %s belongs to another Odoo company/branch.') % rec.picking_type_id.display_name)

    @api.model
    def _context_matches(self, mapping, record):
        if mapping.pos_config_id:
            return bool(
                record and record._name == 'pos.order' and
                'config_id' in record._fields and record.config_id == mapping.pos_config_id
            )
        if mapping.picking_type_id:
            return bool(
                record and record._name == 'stock.picking' and
                'picking_type_id' in record._fields and record.picking_type_id == mapping.picking_type_id
            )
        return True

    @api.model
    def _matching_candidates(self, domain, record=None):
        candidates = self.search(domain, order='priority asc, id asc')
        if record is None:
            return candidates
        contextual = candidates.filtered(lambda mapping: self._context_matches(mapping, record))
        # Context-specific rules are the deterministic override for the matching
        # Odoo object. Priority only orders rules inside the same specificity.
        return contextual.sorted(
            key=lambda mapping: (
                0 if (mapping.pos_config_id or mapping.picking_type_id) else 1,
                mapping.priority,
                mapping.id,
            )
        )

    @api.model
    def get_mapping_for_report(self, report, record=None):
        if not report:
            return False
        base = [('active', '=', True), ('gateway_enabled', '=', True)]

        mapping = self._matching_candidates(base + [('report_id', '=', report.id)], record=record)[:1]
        if mapping:
            return mapping[0]

        try:
            xml_id = report.get_external_id().get(report.id)
            if xml_id:
                mapping = self._matching_candidates(base + [('report_xml_id', '=', xml_id)], record=record)[:1]
                if mapping:
                    return mapping[0]
        except Exception:
            pass

        if report.report_name:
            mapping = self._matching_candidates(base + [('report_name', '=', report.report_name)], record=record)[:1]
            if mapping:
                return mapping[0]

        if report.model:
            mapping = self._matching_candidates(base + [('model_name', '=', report.model)], record=record)[:1]
            if mapping:
                return mapping[0]
        return False

    @api.model
    def get_mapping_for_model(self, model_name, report_name=None, record=None):
        domain = [('active', '=', True), ('gateway_enabled', '=', True)]
        if report_name:
            mapping = self._matching_candidates([('report_name', '=', report_name)] + domain, record=record)[:1]
            if mapping:
                return mapping[0]
        if model_name:
            mapping = self._matching_candidates([('model_name', '=', model_name)] + domain, record=record)[:1]
            if mapping:
                return mapping[0]
        return False
