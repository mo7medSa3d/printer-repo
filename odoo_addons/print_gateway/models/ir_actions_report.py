# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError
import base64
import logging

_logger = logging.getLogger(__name__)

class IrActionsReport(models.Model):
    _inherit = 'ir.actions.report'

    # Add gateway configuration directly to reports for simpler setup
    # This is in addition to the dedicated mapping model for complex cases
    print_gateway_enabled = fields.Boolean(
        string='Gateway Printing Enabled',
        help='If enabled, this report will be routed through Print Gateway instead of normal download. '
             'Uses the report mapping configuration if available, otherwise direct settings below.'
    )
    print_gateway_document_type_id = fields.Many2one(
        'print_gateway.document_type',
        string='Document Type',
        help='Document type for routing (e.g., receipt, invoice, label). If empty, will try to infer from report.'
    )
    print_gateway_branch_id = fields.Many2one(
        'print_gateway.branch',
        string='Branch',
        help='If set, forces this branch. Otherwise determined from record.'
    )
    print_gateway_destination_id = fields.Many2one(
        'print_gateway.destination',
        string='Destination',
        help='If set, forces this destination. Otherwise determined from branch.'
    )

    def _get_gateway_mapping(self):
        """Get the most appropriate mapping for this report."""
        self.ensure_one()
        Mapping = self.env['print_gateway.report_mapping']
        # First check direct report configuration
        if self.print_gateway_enabled:
            # Create a virtual mapping from direct fields for uniform handling
            return {
                'report': self,
                'document_type_id': self.print_gateway_document_type_id,
                'document_type_name': self.print_gateway_document_type_id.name if self.print_gateway_document_type_id else None,
                'branch_id': self.print_gateway_branch_id,
                'destination_id': self.print_gateway_destination_id,
                'gateway_enabled': True,
            }
        # Otherwise check mapping table
        mapping = Mapping.get_mapping_for_report(self)
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

    def _should_route_via_gateway(self):
        """Check if this report should be routed via gateway."""
        self.ensure_one()
        if self.print_gateway_enabled:
            return True
        mapping = self.env['print_gateway.report_mapping'].get_mapping_for_report(self)
        return bool(mapping and mapping.gateway_enabled)

    def _determine_branch(self, record=None, mapping_info=None):
        """Determine branch for a given record/report.
        Priority:
        1. Mapping/report direct branch
        2. Record's print_gateway_branch_id or branch_id
        3. Record's company -> branch with that company
        4. First enabled branch
        """
        # 1. Direct mapping branch
        if mapping_info and mapping_info.get('branch_id'):
            return mapping_info['branch_id']
        
        if record:
            # 2. Try record's branch fields
            for field_name in ['print_gateway_branch_id', 'branch_id', 'branch_ids']:
                if field_name in record._fields:
                    try:
                        branch = record[field_name]
                        if branch:
                            # Handle many2one vs many2many
                            if isinstance(branch, models.BaseModel) and len(branch) > 0:
                                # If it's a print_gateway.branch, return it
                                if branch._name == 'print_gateway.branch':
                                    return branch[0] if len(branch) else branch
                                # If it's res.branch or similar, try to find print_gateway.branch with same id/company
                                # For now, skip and continue to company logic
                                pass
                    except Exception:
                        continue
            
            # 3. Try company-based branch
            if 'company_id' in record._fields and record.company_id:
                branch = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.company_id.id),
                    ('enabled', '=', True)
                ], limit=1)
                if branch:
                    return branch
            
            # 3b. Try partner's company or user company
            if 'partner_id' in record._fields and record.partner_id and record.partner_id.company_id:
                branch = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.partner_id.company_id.id),
                    ('enabled', '=', True)
                ], limit=1)
                if branch:
                    return branch
        
        # 4. Fallback to first enabled branch or mapping branch
        branch = self.env['print_gateway.branch'].search([('enabled', '=', True)], limit=1)
        return branch

    def _determine_destination(self, branch, record=None, mapping_info=None):
        """Determine destination for branch/record."""
        if mapping_info and mapping_info.get('destination_id'):
            dest = mapping_info['destination_id']
            if dest.branch_id == branch:
                return dest
        
        if record:
            for field_name in ['print_gateway_destination_id', 'destination_id']:
                if field_name in record._fields:
                    try:
                        dest = record[field_name]
                        if dest and dest._name == 'print_gateway.destination' and dest.branch_id == branch:
                            return dest
                    except Exception:
                        continue
        
        # Fallback to first POS/kitchen destination for branch
        dest = branch.destination_ids.filtered(lambda d: d.enabled)[:1]
        if dest:
            # Prefer POS
            pos_dest = branch.destination_ids.filtered(lambda d: d.destination_type == 'pos' and d.enabled)[:1]
            return pos_dest or dest
        
        # Any destination
        dest = self.env['print_gateway.destination'].search([('branch_id', '=', branch.id), ('enabled', '=', True)], limit=1)
        return dest

    def _determine_document_type(self, mapping_info=None, report=None):
        """Determine document type string."""
        if mapping_info:
            if mapping_info.get('document_type_id'):
                return mapping_info['document_type_id'].name.lower()
            if mapping_info.get('document_type_name'):
                return mapping_info['document_type_name'].lower()
            if mapping_info.get('mapping') and mapping_info['mapping'].document_type_name:
                return mapping_info['mapping'].document_type_name.lower()
        
        # Fallback based on report model/name
        if report:
            model = report.model or ''
            report_name = report.report_name or ''
            # Common mappings - but configurable via mapping table is preferred
            if 'sale.order' in model or 'sale.report_saleorder' in report_name:
                return 'order'
            elif 'account.move' in model or 'account.report_invoice' in report_name:
                return 'invoice'
            elif 'stock.picking' in model or 'stock.report_picking' in report_name:
                return 'delivery'
            elif 'purchase.order' in model:
                return 'purchase_order'
            elif 'pos.order' in model:
                return 'receipt'
        
        return 'document'

    def _generate_payload_for_report(self, report_ref, res_ids, data=None):
        """Generate the actual printable payload for a report.
        Returns dict with type, encoding, data (base64).
        Respects report_mapping.payload_type if available; honest about content.
        - pdf  -> type 'pdf'  (requires spooler/IPP, never raw thermal)
        - raw  -> type 'raw'  (same PDF bytes but legacy type)
        - escpos -> raises UserError (no PDF->ESC/POS rasterizer)
        """
        self.ensure_one()
        # Determine desired payload type from mapping (if any)
        desired_type = 'pdf'  # default honest type for QWeb PDF
        try:
            mi = self._get_gateway_mapping()
            if mi and mi.get('payload_type'):
                desired_type = mi['payload_type']
            elif mi and mi.get('mapping') and mi['mapping'].payload_type:
                desired_type = mi['mapping'].payload_type
        except Exception:
            pass
        if desired_type == 'escpos':
            # No automatic PDF->ESC/POS conversion exists. Sending PDF bytes
            # as escpos to a thermal printer would produce garbage and false
            # success. Fail fast so admin can fix mapping (use pdf+spooler
            # or provide pre-formatted ESC/POS payload).
            raise UserError(_("Report %s is mapped to ESC/POS but no PDF-to-ESC/POS conversion is configured. Change mapping payload_type to 'pdf' (spooler/IPP) or provide ESC/POS payload manually.") % (self.report_name or str(report_ref)))

        # Render the report to get actual PDF bytes
        try:
            if hasattr(self, '_render_qweb_pdf'):
                report = self._get_report(report_ref) if hasattr(self, '_get_report') else self
                if isinstance(report_ref, str):
                    report = self._get_report(report_ref)
                else:
                    report = report_ref if isinstance(report_ref, models.Model) else self

                pdf_content = None
                if hasattr(self, '_render_qweb_pdf'):
                    try:
                        pdf_content, _ = self._render_qweb_pdf(report_ref, res_ids=res_ids, data=data)
                    except TypeError:
                        pdf_content, _ = self._render_qweb_pdf(report_ref, res_ids, data)

                if pdf_content and len(pdf_content) > 0:
                    if isinstance(pdf_content, (list, tuple)):
                        pdf_content = pdf_content[0]

                    b64 = base64.b64encode(pdf_content).decode('ascii')
                    # Honest type: pdf (or raw legacy) — gateway will enforce
                    # capability (pdf only to spooler/IPP, never to raw thermal)
                    payload_type = 'pdf' if desired_type in ('pdf', 'escpos') else 'raw'
                    # raw is kept for backward compat but maps to same PDF bytes
                    if desired_type == 'raw':
                        payload_type = 'raw'
                    else:
                        payload_type = 'pdf'
                    return {
                        'type': payload_type,
                        'encoding': 'base64',
                        'data': b64,
                    }
        except UserError:
            raise
        except Exception as e:
            _logger.warning("Failed to render report %s for ids %s: %s", report_ref, res_ids, str(e))
            raise UserError(_("Failed to generate report for printing: %s") % str(e))

        raise UserError(_("Could not generate printable payload for report %s") % str(report_ref))

    def _route_via_gateway(self, report_ref, res_ids, data=None):
        """Main gateway routing logic. Returns print job record or raises."""
        self.ensure_one()
        
        # Need at least one record to determine branch/destination
        if not res_ids:
            raise UserError(_("No records to print for report %s") % self.name)
        
        # Get mapping
        mapping_info = self._get_gateway_mapping()
        if not mapping_info or not mapping_info.get('gateway_enabled'):
            return None  # Not configured for gateway, fallback to normal
        
        # For each record, we create a print job - for simplicity, handle first record's branch/destination
        # For multiple records, we could create multiple jobs, but for now batch as one job with first record's routing
        # Get the actual record
        model_name = self.model
        if not model_name:
            # Try to get from report
            report = self._get_report(report_ref) if hasattr(self, '_get_report') else self
            model_name = report.model if hasattr(report, 'model') else None
        
        record = None
        branch = None
        destination = None
        document_type = None
        
        if model_name and res_ids:
            try:
                Model = self.env[model_name]
                records = Model.browse(res_ids)
                if records and len(records) > 0:
                    record = records[0]
                    branch = self._determine_branch(record, mapping_info)
                    destination = self._determine_destination(branch, record, mapping_info)
                    document_type = self._determine_document_type(mapping_info, self)
                else:
                    branch = mapping_info.get('branch_id') or self.env['print_gateway.branch'].search([('enabled', '=', True)], limit=1)
                    destination = mapping_info.get('destination_id') or (branch.destination_ids[:1] if branch and branch.destination_ids else None)
                    document_type = self._determine_document_type(mapping_info, self)
            except Exception as e:
                _logger.warning("Failed to determine routing for model %s: %s", model_name, str(e))
                branch = mapping_info.get('branch_id') or self.env['print_gateway.branch'].search([('enabled', '=', True)], limit=1)
                destination = mapping_info.get('destination_id')
                document_type = self._determine_document_type(mapping_info, self)
        else:
            branch = mapping_info.get('branch_id') or self.env['print_gateway.branch'].search([('enabled', '=', True)], limit=1)
            destination = mapping_info.get('destination_id')
            document_type = self._determine_document_type(mapping_info, self)
        
        if not branch:
            raise UserError(_("No print branch configured. Please configure a Print Gateway Branch first."))
        if not destination:
            raise UserError(_("No destination configured for branch %s. Create a destination (POS/Kitchen/Warehouse).") % branch.name)
        
        # Generate actual payload
        payload = self._generate_payload_for_report(report_ref, res_ids, data)
        
        # Stable idempotency key per logical print operation (one report_action call = one key).
        # Generated here so branch.create_print_job retry logic reuses the SAME key.
        import uuid as _uuid
        idempotency_key = _uuid.uuid4().hex

        # Send to Gateway via branch helper (idempotent)
        try:
            job = branch.create_print_job(
                destination.gateway_destination_id or destination.id,
                document_type,
                payload,
                odoo_model=model_name,
                odoo_record_id=res_ids[0] if res_ids else None,
                report_xml_id=self.get_external_id().get(self.id, '') if hasattr(self, 'get_external_id') else self.report_name,
                report_name=self.report_name,
                idempotency_key=idempotency_key,
            )
            _logger.info("Report %s for %s[%s] queued as gateway job %s via %s -> %s (%s)", 
                        self.report_name, model_name, res_ids, job.gateway_job_id, branch.name, destination.name, document_type)
            return job
        except Exception as e:
            _logger.error("Gateway print failed for report %s: %s", self.report_name, str(e))
            # Check fallback behavior
            mapping = mapping_info.get('mapping')
            if mapping and not mapping.fallback_to_normal:
                raise UserError(_("Gateway printing failed for %s: %s") % (self.name, str(e)))
            elif self.print_gateway_enabled and not (mapping and mapping.fallback_to_normal):
                # For direct report config, if fallback is not set, we should still fallback to normal
                # But if gateway_enabled is True and we failed, we should show error, not silently fallback
                # Let's create a failed job and then fallback
                pass
            raise UserError(_("Print Gateway failed for %s: %s. Check Gateway connection and try again.") % (self.name, str(e)))

    # Override report_action to intercept standard Print button
    def report_action(self, docids, data=None, config=True):
        """Override standard report action to optionally route via Gateway."""
        self.ensure_one()
        
        # Check if this report should be routed via gateway
        # We need to be careful to not break non-PDF reports or many records
        should_gateway = self._should_route_via_gateway()
        
        if not should_gateway:
            # Normal Odoo behavior
            return super().report_action(docids, data=data, config=config)
        
        # For gateway-enabled reports, we try to route via gateway
        # But we need to handle the case where docids is None or empty (like for wizard)
        if not docids:
            return super().report_action(docids, data=data, config=config)
        
        # Normalize docids
        if isinstance(docids, int):
            docids = [docids]
        elif isinstance(docids, str):
            # Could be a string ID
            try:
                docids = [int(docids)]
            except:
                return super().report_action(docids, data=data, config=config)
        
        try:
            # Try gateway routing
            job = self._route_via_gateway(self, docids, data)
            if job:
                # Successfully queued via gateway - return notification + optionally the PDF
                # For now, we return a notification and also allow PDF download as fallback
                # The user will see a notification that job was sent to printer
                # We could either return the PDF or just the notification
                # To preserve UX, we return both: first the gateway job notification,
                # and the PDF will be handled via separate download if needed
                # For now, return client notification and also trigger PDF download in background?
                # Simpler: return notification and don't block PDF - but that would be duplicate
                # Better: create job and also return the normal report action so user gets PDF
                # Let's try to do both: create job, then return normal action with a notification
                # We will use a trick: return normal report action but with a message
                # For now, just return gateway job notification and log that PDF would also be available
                
                # Option 1: Return only gateway notification (no PDF download)
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('Print Job Sent to Gateway'),
                        'message': _('Report %s for %d record(s) queued as job %s (%s -> %s). Status: %s') % (
                            self.name, len(docids), job.gateway_job_id, 
                            job.branch_id.name, job.destination_id.name if job.destination_id else 'N/A',
                            job.status
                        ),
                        'type': 'success',
                        'sticky': False,
                        'next': {'type': 'ir.actions.act_window_close'},
                    }
                }
        except UserError:
            raise
        except Exception as e:
            _logger.error("Unexpected error in gateway report routing for %s: %s", self.report_name, str(e), exc_info=True)
            # Fallback to normal on unexpected error if configured
            mapping_info = self._get_gateway_mapping()
            mapping = mapping_info.get('mapping') if mapping_info else None
            if mapping and mapping.fallback_to_normal:
                _logger.info("Falling back to normal report for %s after gateway error", self.report_name)
                return super().report_action(docids, data=data, config=config)
            raise UserError(_("Gateway printing failed: %s. Falling back to normal print.") % str(e))
        
        # If gateway routing didn't create a job (shouldn't happen), fallback
        return super().report_action(docids, data=data, config=config)

    # Also override _render_qweb_pdf for cases where report is generated directly
    # We don't want to double-intercept, so we only handle report_action
