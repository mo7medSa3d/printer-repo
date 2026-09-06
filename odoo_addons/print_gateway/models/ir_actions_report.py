# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError, ValidationError
import base64
import logging

_logger = logging.getLogger(__name__)

class IrActionsReport(models.Model):
    _inherit = 'ir.actions.report'

    print_gateway_enabled = fields.Boolean(
        string='Gateway Printing Enabled',
        help='If enabled, this report will be routed through Print Gateway instead of normal download. Uses the report mapping configuration if available, otherwise direct settings below.'
    )
    print_gateway_document_type_id = fields.Many2one(
        'print_gateway.document_type',
        string='Document Type',
        help='Document type for routing. If empty, the configured print rule is used.'
    )
    print_gateway_branch_id = fields.Many2one(
        'print_gateway.branch',
        string='Branch',
        help='If set, forces this branch. Otherwise determined from the record company/branch.'
    )
    print_gateway_destination_id = fields.Many2one(
        'print_gateway.destination',
        string='Destination',
        help='Optional direct override. Prefer Print Rules so the destination is selected automatically from Odoo context.'
    )

    def _get_gateway_mapping(self, record=None):
        """Get the most appropriate mapping for this report and record context."""
        self.ensure_one()
        Mapping = self.env['print_gateway.report_mapping']
        if self.print_gateway_enabled:
            return {
                'report': self,
                'document_type_id': self.print_gateway_document_type_id,
                'document_type_name': self.print_gateway_document_type_id.name if self.print_gateway_document_type_id else None,
                'branch_id': self.print_gateway_branch_id,
                'destination_id': self.print_gateway_destination_id,
                'gateway_enabled': True,
            }

        mapping = Mapping.get_mapping_for_report(self, record=record)
        if mapping:
            return {
                'report': self,
                'document_type_id': mapping.document_type_id,
                'document_type_name': mapping.document_type_id.name if mapping.document_type_id else mapping.document_type_name,
                'branch_id': mapping.branch_id,
                'destination_id': mapping.destination_id,
                'gateway_enabled': mapping.gateway_enabled,
                'payload_type': mapping.payload_type,
                'mapping': mapping,
            }
        return None

    def _user_has_branch_access(self, branch):
        if not branch or not branch.company_id:
            return False
        return branch.company_id.id in self.env.user.company_ids.ids

    def _should_route_via_gateway(self):
        self.ensure_one()
        if self.print_gateway_enabled:
            return True
        mapping = self.env['print_gateway.report_mapping'].get_mapping_for_report(self)
        return bool(mapping and mapping.gateway_enabled)

    def _determine_branch(self, record=None, mapping_info=None):
        if mapping_info and mapping_info.get('branch_id'):
            return mapping_info['branch_id']

        if record:
            if 'print_gateway_branch_id' in record._fields:
                try:
                    branch = record.print_gateway_branch_id
                    if branch and len(branch) > 0:
                        return branch
                except Exception as e:
                    _logger.warning("Failed to read print_gateway_branch_id from record: %s", str(e))

            if 'company_id' in record._fields and record.company_id:
                branches = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.company_id.id),
                    ('enabled', '=', True)
                ])
                if len(branches) == 1:
                    return branches[0]
                if len(branches) > 1:
                    raise ValidationError(_(
                        "Multiple Print Gateway branches are configured for company %s. "
                        "Create an explicit Print Rule for this report."
                    ) % record.company_id.name)

            if 'partner_id' in record._fields and record.partner_id and record.partner_id.company_id:
                branches = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.partner_id.company_id.id),
                    ('enabled', '=', True)
                ])
                if len(branches) == 1:
                    return branches[0]
                if len(branches) > 1:
                    raise ValidationError(_(
                        "Multiple Print Gateway branches are configured for partner company %s. "
                        "Create an explicit Print Rule for this report."
                    ) % record.partner_id.company_id.name)

        raise ValidationError(_(
            "Unable to determine the print branch for this report. "
            "Configure an Odoo company/branch or an explicit Print Rule."
        ))

    def _determine_destination(self, branch, record=None, mapping_info=None):
        if not branch:
            raise ValidationError(_("Branch is required to determine destination"))

        if mapping_info and mapping_info.get('destination_id'):
            dest = mapping_info['destination_id']
            if dest.branch_id.id != branch.id:
                raise ValidationError(_(
                    "Destination %s belongs to branch %s, not selected branch %s. Cross-branch routing is not allowed."
                ) % (dest.name, dest.branch_id.name, branch.name))
            return dest

        if record and 'print_gateway_destination_id' in record._fields:
            try:
                dest = record.print_gateway_destination_id
                if dest and len(dest) > 0:
                    if dest.branch_id.id != branch.id:
                        raise ValidationError(_(
                            "Record destination %s belongs to branch %s, not selected branch %s"
                        ) % (dest.name, dest.branch_id.name, branch.name))
                    return dest
            except ValidationError:
                raise
            except Exception as e:
                _logger.warning("Failed to read destination from record: %s", str(e))

        raise ValidationError(_(
            "No print destination is configured for %s. Configure a Print Rule for this report/context."
        ) % branch.name)

    def _determine_document_type(self, mapping_info=None, report=None):
        if mapping_info:
            if mapping_info.get('document_type_id'):
                dt_name = mapping_info['document_type_id'].name
                return dt_name.strip().lower() if dt_name else None
            if mapping_info.get('document_type_name'):
                return mapping_info['document_type_name'].strip().lower()

        if report:
            model = report.model or ''
            report_name = report.report_name or ''
            if 'sale.order' in model or 'sale.report_saleorder' in report_name:
                return 'order'
            if 'account.move' in model or 'account.report_invoice' in report_name:
                return 'invoice'
            if 'stock.picking' in model or 'stock.report_picking' in report_name:
                return 'delivery'
            if 'purchase.order' in model:
                return 'purchase_order'
            if 'pos.order' in model:
                return 'receipt'
        return 'document'

    def _generate_payload_for_report(self, report_ref, res_ids, data=None):
        """Generate an honest printable payload. QWeb reports are PDF only."""
        self.ensure_one()
        desired_type = 'pdf'
        try:
            mi = self._get_gateway_mapping()
            if mi and mi.get('payload_type'):
                desired_type = mi['payload_type']
            elif mi and mi.get('mapping') and mi['mapping'].payload_type:
                desired_type = mi['mapping'].payload_type
        except Exception:
            pass

        if desired_type == 'escpos':
            raise UserError(_(
                "Report %s is mapped to ESC/POS but no PDF-to-ESC/POS conversion is configured. "
                "Use PDF with spooler/IPP or submit an ESC/POS payload through the direct print-job API."
            ) % self.name)

        try:
            if hasattr(self, '_render_qweb_pdf'):
                report = self._get_report(report_ref) if hasattr(self, '_get_report') else self
                if isinstance(report_ref, str):
                    report = self._get_report(report_ref)
                else:
                    report = report_ref if isinstance(report_ref, models.Model) else self

                pdf_content = None
                try:
                    pdf_content, _ = self._render_qweb_pdf(report_ref, res_ids=res_ids, data=data)
                except TypeError:
                    pdf_content, _ = self._render_qweb_pdf(report_ref, res_ids, data)

                if pdf_content and len(pdf_content) > 0:
                    if isinstance(pdf_content, (list, tuple)):
                        pdf_content = pdf_content[0]
                    return {
                        'type': 'pdf',
                        'encoding': 'base64',
                        'data': base64.b64encode(pdf_content).decode('ascii'),
                    }
        except UserError:
            raise
        except Exception as e:
            _logger.warning("Failed to render report %s for ids %s: %s", report_ref, res_ids, str(e))
            raise UserError(_("Failed to generate report for printing: %s") % str(e))

        raise UserError(_("Could not generate printable payload for report %s") % str(report_ref))

    def _validate_recordset_routing_consistency(self, records, mapping_info):
        if not records:
            raise ValidationError(_("Cannot print an empty report."))

        routing_groups = []
        for record in records:
            context_mapping = mapping_info
            # A contextual rule is selected per record so mixed recordsets
            # cannot silently inherit the first record's destination.
            if record != records[0]:
                context_mapping = self._get_gateway_mapping(record=record) or mapping_info

            branch = self._determine_branch(record, context_mapping)
            destination = self._determine_destination(branch, record, context_mapping)
            doc_type = self._determine_document_type(context_mapping, self)

            matching_group = None
            for group in routing_groups:
                if (group['branch'].id == branch.id and
                    group['destination'].id == destination.id and
                    group['document_type'] == doc_type):
                    matching_group = group
                    break

            if matching_group:
                matching_group['records'] += record
            else:
                routing_groups.append({
                    'records': record,
                    'branch': branch,
                    'destination': destination,
                    'document_type': doc_type,
                })

        if len(routing_groups) > 1:
            raise ValidationError(_(
                "This report contains records with different print routing. "
                "Print them separately or create matching context-specific Print Rules."
            ))
        return routing_groups

    # NOTE (audit #18): report_action remains implemented by async_report.py.
    # This class only owns routing/payload helpers so there is a single durable
    # asynchronous report-dispatch implementation.
