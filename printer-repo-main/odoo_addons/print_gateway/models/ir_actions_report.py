# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import UserError, ValidationError
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

    def _user_has_branch_access(self, branch):
        """SECURITY: Check if user has access to branch's company."""
        if not branch or not branch.company_id:
            return False
        return branch.company_id.id in self.env.user.company_ids.ids

    def _should_route_via_gateway(self):
        """Check if this report should be routed via gateway."""
        self.ensure_one()
        if self.print_gateway_enabled:
            return True
        mapping = self.env['print_gateway.report_mapping'].get_mapping_for_report(self)
        return bool(mapping and mapping.gateway_enabled)

    def _determine_branch(self, record=None, mapping_info=None):
        """Determine branch for a given record/report.

        FAIL-CLOSED behavior: raises ValidationError if branch cannot be
        deterministically resolved. Never falls back to arbitrary first branch.

        Priority:
        1. Mapping/report direct branch (explicit/forced)
        2. Record's print_gateway_branch_id field (if exists)
        3. Record's company -> branch with that company (must be unique/deterministic)

        If no deterministic branch can be found, raises ValidationError.
        """
        # 1. Direct mapping branch (explicit)
        if mapping_info and mapping_info.get('branch_id'):
            return mapping_info['branch_id']

        if record:
            # 2. Try record's explicit branch field
            if 'print_gateway_branch_id' in record._fields:
                try:
                    branch = record.print_gateway_branch_id
                    if branch and len(branch) > 0:
                        return branch
                except Exception as e:
                    _logger.warning("Failed to read print_gateway_branch_id from record: %s", str(e))

            # 3. Try company-based branch (must be unique per company for determinism)
            if 'company_id' in record._fields and record.company_id:
                branches = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.company_id.id),
                    ('enabled', '=', True)
                ])
                if len(branches) == 1:
                    # Unique branch for this company - deterministic
                    return branches[0]
                elif len(branches) > 1:
                    # Multiple branches for same company - ambiguous, fail closed
                    raise ValidationError(_(
                        "Multiple print branches are configured for company %s. "
                        "Cannot determine routing unambiguously. "
                        "Please configure explicit branch in report mapping."
                    ) % record.company_id.name)
                # else: no branch for company, continue

            # 3b. Try partner's company as fallback
            if 'partner_id' in record._fields and record.partner_id and record.partner_id.company_id:
                branches = self.env['print_gateway.branch'].search([
                    ('company_id', '=', record.partner_id.company_id.id),
                    ('enabled', '=', True)
                ])
                if len(branches) == 1:
                    return branches[0]
                elif len(branches) > 1:
                    raise ValidationError(_(
                        "Multiple print branches configured for partner's company %s. "
                        "Cannot determine routing unambiguously."
                    ) % record.partner_id.company_id.name)

        # No deterministic branch found - fail closed
        raise ValidationError(_(
            "Unable to determine the print branch for this report. "
            "Please configure an explicit branch in the report mapping or ensure the record has a valid company with a unique print branch."
        ))

    def _determine_destination(self, branch, record=None, mapping_info=None):
        """Determine destination for branch/record.

        FAIL-CLOSED: Raises if destination cannot be determined or belongs to wrong branch.
        """
        if not branch:
            raise ValidationError(_("Branch is required to determine destination"))

        # 1. Explicit mapping destination (forced)
        if mapping_info and mapping_info.get('destination_id'):
            dest = mapping_info['destination_id']
            if dest.branch_id.id != branch.id:
                raise ValidationError(_(
                    "Destination %s belongs to branch %s, not selected branch %s. "
                    "Cross-branch routing is not allowed."
                ) % (dest.name, dest.branch_id.name, branch.name))
            return dest

        # 2. Try record's explicit destination field
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

        # No implicit/default/first destination selection. A destination is a
        # routing key and must be explicit in the mapping or record.
        raise ValidationError(_(
            "Unable to determine a print destination for branch %s. "
            "Configure an explicit destination in the report mapping or record."
        ) % branch.name)

    def _determine_document_type(self, mapping_info=None, report=None):
        """Determine document type string (normalized lowercase)."""
        if mapping_info:
            if mapping_info.get('document_type_id'):
                dt_name = mapping_info['document_type_id'].name
                return dt_name.strip().lower() if dt_name else None
            if mapping_info.get('document_type_name'):
                return mapping_info['document_type_name'].strip().lower()

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
            raise UserError(_("Report %s is mapped to ESC/POS but no PDF-to-ESC/POS conversion is configured. Change mapping payload_type to 'pdf' (spooler/IPP) or provide ESC/POS payload manually.") % self.name)

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
                    # A rendered QWeb report is a PDF document. It is never
                    # relabeled as RAW; ambiguous PDF->RAW is rejected by the
                    # canonical gateway content contract.
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

    def _validate_recordset_routing_consistency(self, records, mapping_info):
        """Validate that all records in a multi-record reportset have consistent routing.

        Returns list of routing groups if all records have consistent routing,
        or raises ValidationError if recordset is heterogeneous.

        For simplicity and safety: current implementation rejects heterogeneous recordsets.
        Advanced multi-group splitting can be added later if report rendering supports it.
        """
        if not records:
            raise ValidationError(_("Cannot print an empty report."))

        # Resolve routing for EVERY record, including a single-record
        # report. Returning branch=None for len==1 used to make
        # _route_via_gateway fail closed with "No print branch configured"
        # even when a unique branch existed — or, worse, skip validation
        # and fall through to records[0] elsewhere. Fail closed here.
        routing_groups = []
        for record in records:
            branch = self._determine_branch(record, mapping_info)
            destination = self._determine_destination(branch, record, mapping_info)
            doc_type = self._determine_document_type(mapping_info, self)

            # Try to find existing group with same routing
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

        # If multiple routing groups, reject (heterogeneous recordset)
        if len(routing_groups) > 1:
            raise ValidationError(_(
                "This report contains records with different print routing (branch/destination/document type). "
                "Please print records separately to ensure correct routing. "
                "Groups found: %d"
            ) % len(routing_groups))

        return routing_groups

    def _route_via_gateway(self, report_ref, res_ids, data=None):
        """Main gateway routing logic. Returns print job record or raises.
        SECURITY: Validates user has access to determined branch's company.

        Processing order (FAIL-CLOSED):
        1. Validate recordset is not empty
        2. Validate routing is deterministic and consistent
        3. Render PDF
        4. Build payload
        5. Create one persisted logical-operation identity
        6. Call Gateway using that persisted identity
        """
        self.ensure_one()

        # Step 1: Validate non-empty recordset
        if not res_ids:
            raise ValidationError(_("No records to print for report %s") % self.name)

        # Get mapping
        mapping_info = self._get_gateway_mapping()
        if not mapping_info or not mapping_info.get('gateway_enabled'):
            return None  # Not configured for gateway, fallback to normal

        # Get the actual records
        model_name = self.model
        if not model_name:
            # Try to get from report
            report = self._get_report(report_ref) if hasattr(self, '_get_report') else self
            model_name = report.model if hasattr(report, 'model') else None

        if not model_name:
            raise ValidationError(_("Report model not found"))

        # Step 2: Validate recordset and routing consistency
        try:
            Model = self.env[model_name]
        except KeyError:
            raise ValidationError(_("Model %s not found") % model_name)

        try:
            records = Model.browse(res_ids)
        except Exception as e:
            raise ValidationError(_("Failed to load records: %s") % str(e))

        # Check if records actually exist
        if not records or len(records) == 0:
            raise ValidationError(_("Cannot print an empty report."))

        # Validate routing consistency
        routing_groups = self._validate_recordset_routing_consistency(records, mapping_info)

        # Use first (and only) routing group
        routing_group = routing_groups[0]
        branch = routing_group['branch']
        destination = routing_group['destination']
        document_type = routing_group['document_type']

        if not branch:
            raise ValidationError(_("No print branch configured. Please configure a Print Gateway Branch first."))
        if not destination:
            raise ValidationError(_("No destination configured for branch %s. Create a destination (POS/Kitchen/Warehouse).") % branch.name)

        # SECURITY: Validate user has access to branch's company
        if not self._user_has_branch_access(branch):
            raise ValidationError(_("You do not have access to branch %s. Cannot print via this branch.") % branch.name)

        # SECURITY: Validate record's company matches branch's company (if record has company field)
        for record in records:
            if 'company_id' in record._fields and record.company_id and record.company_id.id != branch.company_id.id:
                raise ValidationError(_("Cannot route record from company %s to branch in company %s. Please route to correct company's branch.") % (record.company_id.name, branch.company_id.name))

        # Step 3: Render PDF (only after routing validation)
        payload = self._generate_payload_for_report(report_ref, res_ids, data)

        # Step 4: Create exactly one logical-operation identity for this manual
        # print invocation. The key is persisted before the network call by
        # branch.create_print_job and is reused by timeout/worker retries.
        import uuid as _uuid
        idempotency_key = _uuid.uuid4().hex

        # Step 5: Persist local outbox operation and submit only after the
        # surrounding Odoo transaction commits. Retries use the persisted key.
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
                defer_until_commit=True,
            )
            _logger.info("Report %s for %s[%s] persisted as logical print operation %s via %s -> %s (%s); Gateway submission is post-commit",
                        self.report_name, model_name, res_ids, job.idempotency_key[:8], branch.name, destination.name, document_type)
            return job
        except ValidationError:
            raise
        except Exception as e:
            _logger.error("Gateway print failed for report %s: %s", self.report_name, str(e))
            # Check fallback behavior
            mapping = mapping_info.get('mapping')
            if mapping and not mapping.fallback_to_normal:
                raise ValidationError(_("Gateway printing failed for %s: %s") % (self.name, str(e)))
            elif self.print_gateway_enabled and not (mapping and mapping.fallback_to_normal):
                raise ValidationError(_("Print Gateway failed for %s: %s. Check Gateway connection and try again.") % (self.name, str(e)))
            raise

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
            except (TypeError, ValueError):
                return super().report_action(docids, data=data, config=config)

        try:
            # Try gateway routing
            job = self._route_via_gateway(self, docids, data)
            if job:
                # Successfully queued via gateway - return notification
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {
                        'title': _('Print Job Queued'),
                        'message': _('Report %s for %d record(s) persisted as operation %s (%s -> %s). Gateway submission will run after commit.') % (
                            self.name, len(docids), job.idempotency_key[:8],
                            job.branch_id.name, job.destination_id.name if job.destination_id else 'N/A',
                            job.status
                        ),
                        'type': 'success',
                        'sticky': False,
                        'next': {'type': 'ir.actions.act_window_close'},
                    }
                }
        except ValidationError:
            raise
        except UserError:
            raise
        except Exception as e:
            _logger.error("Unexpected error in gateway report routing for %s: %s", self.report_name, str(e), exc_info=True)
            raise UserError(_("Gateway printing failed: %s") % str(e))

        # If gateway routing didn't create a job (shouldn't happen), fallback
        return super().report_action(docids, data=data, config=config)
