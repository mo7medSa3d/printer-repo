# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import requests
import logging
import time
import uuid

_logger = logging.getLogger(__name__)

class PrintGatewayBranch(models.Model):
    _name = 'print_gateway.branch'
    _description = 'Print Gateway Branch'
    _order = 'name'

    name = fields.Char(string='Branch Name', required=True, help='e.g., Cairo Branch')
    company_id = fields.Many2one('res.company', string='Company', ondelete='cascade')
    gateway_url = fields.Char(string='Gateway URL', required=True, help='Base URL of print gateway, e.g., https://print.example.com')
    gateway_api_key = fields.Char(string='Gateway API Key', help='Odoo API key scoped to this branch (created in Gateway dashboard). Keep secret.', copy=False)
    enabled = fields.Boolean(default=True)
    description = fields.Text()
    location = fields.Char()
    timezone = fields.Char(default='Africa/Cairo')
    gateway_branch_id = fields.Char(string='Gateway Branch ID', help='ID in Gateway DB; defaults to Odoo record id if empty', copy=False)

    destination_ids = fields.One2many('print_gateway.destination', 'branch_id', string='Destinations')
    printer_ids = fields.One2many('print_gateway.printer', 'branch_id', string='Printers')
    document_type_ids = fields.One2many('print_gateway.document_type', 'branch_id', string='Document Types')
    binding_ids = fields.One2many('print_gateway.printer_binding', 'branch_id', string='Printer Bindings')
    agent_ids = fields.One2many('print_gateway.agent', 'branch_id', string='Agents')

    agent_count = fields.Integer(compute='_compute_counts', string='Agents Online')
    printer_count = fields.Integer(compute='_compute_counts', string='Printers Total')
    last_sync_at = fields.Datetime(string='Last Sync At', readonly=True)

    _sql_constraints = [
        ('name_company_unique', 'unique(name, company_id)', 'Branch name must be unique per company'),
    ]

    def create(self, vals):
        """Ensure created branch is in user's company."""
        if 'company_id' not in vals:
            vals['company_id'] = self.env.company.id
        # Prevent users from creating branches in other companies
        if vals.get('company_id') and vals['company_id'] != self.env.company.id:
            from odoo.exceptions import AccessError
            raise AccessError(_("You cannot create branches outside your company."))
        return super().create(vals)

    def write(self, vals):
        """Prevent company change and validate access."""
        if 'company_id' in vals:
            for rec in self:
                if rec.company_id.id != vals['company_id']:
                    from odoo.exceptions import AccessError
                    raise AccessError(_("You cannot change a branch's company. Please create a new branch instead."))
        self._check_company_access()
        return super().write(vals)

    def _check_company_access(self):
        """Verify user has access to branch's company."""
        for rec in self:
            if rec.company_id and rec.company_id.id not in self.env.user.company_ids.ids:
                from odoo.exceptions import AccessError
                raise AccessError(_("You do not have access to branch %s's company.") % rec.name)

    @api.depends('agent_ids', 'agent_ids.status', 'printer_ids')
    def _compute_counts(self):
        for rec in self:
            rec.agent_count = len(rec.agent_ids.filtered(lambda a: a.status == 'online'))
            rec.printer_count = len(rec.printer_ids)

    def _gateway_headers(self):
        if not self.gateway_api_key:
            raise ValidationError(_('Gateway API key not configured for branch %s') % self.name)
        return {
            'Authorization': f'Bearer {self.gateway_api_key}',
            'Content-Type': 'application/json',
        }

    def _gateway_base(self):
        if not self.gateway_url:
            raise ValidationError(_('Gateway URL not configured for branch %s') % self.name)
        return self.gateway_url.rstrip('/')

    def action_test_connection(self):
        self.ensure_one()
        try:
            url = f"{self._gateway_base()}/api/health"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                return {
                    'type': 'ir.actions.client',
                    'tag': 'display_notification',
                    'params': {'title': _('Connection OK'), 'message': _('Gateway reachable'), 'type': 'success'},
                }
            else:
                raise ValidationError(_('Gateway returned %s: %s') % (resp.status_code, resp.text[:200]))
        except requests.RequestException as e:
            raise ValidationError(_('Cannot reach Gateway: %s') % str(e))

    def action_sync_from_gateway(self):
        """Pull agents and printers status from Gateway (Gateway -> Odoo). Idempotent."""
        for branch in self:
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                # Gateway ids are strings; Odoo record ids must be stringified
                # before they are used as branchId query params (the Gateway
                # compares them against text columns and branch-scoped keys).
                gateway_branch_id = str(branch.gateway_branch_id or branch.id)
                # Sync agents
                resp = requests.get(f"{base}/api/odoo/agents", params={'branchId': gateway_branch_id}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for ag in resp.json():
                        existing = branch.env['print_gateway.agent'].search([('gateway_agent_id', '=', ag.get('id')), ('branch_id', '=', branch.id)], limit=1)
                        vals = {
                            'branch_id': branch.id,
                            'gateway_agent_id': ag.get('id'),
                            'name': ag.get('name') or ag.get('id'),
                            'status': ag.get('status') or 'unknown',
                            'last_seen_at': ag.get('lastSeenAt'),
                        }
                        if existing:
                            existing.write(vals)
                        else:
                            branch.env['print_gateway.agent'].create(vals)
                # Sync printers
                resp = requests.get(f"{base}/api/odoo/printers", params={'branchId': gateway_branch_id}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for pr in resp.json():
                        existing = branch.env['print_gateway.printer'].search([('gateway_printer_id', '=', pr.get('id')), ('branch_id', '=', branch.id)], limit=1)
                        vals = {
                            'branch_id': branch.id,
                            'gateway_printer_id': pr.get('id'),
                            'name': pr.get('name'),
                            'printer_type': pr.get('printerType') or pr.get('printer_type') or 'unknown',
                            'connection_type': pr.get('connectionType') or pr.get('connection_type') or 'tcp',
                            'protocol': pr.get('protocol') or 'raw',
                            'status': pr.get('status') or 'unknown',
                            'enabled': pr.get('enabled', True),
                            'gateway_agent_id': pr.get('agentId') or pr.get('agent_id'),
                        }
                        # Extract config
                        cfg = pr.get('config') or {}
                        vals.update({
                            'ip_address': cfg.get('ip'),
                            'port': cfg.get('port'),
                            'spooler_name': cfg.get('spooler_name'),
                        })
                        if existing:
                            existing.write(vals)
                        else:
                            branch.env['print_gateway.printer'].create(vals)
                branch.last_sync_at = fields.Datetime.now()
                _logger.info("Branch %s sync from gateway completed", branch.name)
            except requests.RequestException as e:
                _logger.error("Branch %s sync failed: %s", branch.name, str(e))
                raise ValidationError(_('Sync failed: %s') % str(e))
        return True

    def action_sync_to_gateway(self):
        """Push branches/destinations/document_types/bindings to Gateway (Odoo -> Gateway). Idempotent."""
        for branch in self:
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                payload = {
                    'branches': [{
                        'id': str(branch.gateway_branch_id or branch.id),
                        'name': branch.name,
                        'description': branch.description,
                        'location': branch.location,
                        'enabled': branch.enabled,
                    }],
                    'destinations': [{
                        'id': str(d.gateway_destination_id or d.id),
                        'branchId': str(branch.gateway_branch_id or branch.id),
                        'name': d.name,
                        'type': d.destination_type,
                        'description': d.description,
                        'zone': d.zone,
                        'enabled': d.enabled,
                    } for d in branch.destination_ids],
                    'bindings': [{
                        'id': str(b.gateway_binding_id or b.id),
                        'branchId': str(branch.gateway_branch_id or branch.id),
                        'destinationId': str(b.destination_id.gateway_destination_id or b.destination_id.id),
                        'documentType': b.document_type_id.name if b.document_type_id else b.document_type,
                        'printerId': str(b.printer_id.gateway_printer_id or b.printer_id.id),
                        'priority': b.priority,
                        'enabled': b.enabled,
                    } for b in branch.binding_ids],
                }
                resp = requests.post(f"{base}/api/odoo/sync", json=payload, headers=headers, timeout=10)
                if resp.status_code not in (200, 201):
                    raise ValidationError(_('Gateway sync failed %s: %s') % (resp.status_code, resp.text[:500]))
                _logger.info("Branch %s sync to gateway OK: %s", branch.name, resp.text[:500])
                branch.last_sync_at = fields.Datetime.now()
            except requests.RequestException as e:
                raise ValidationError(_('Sync to gateway failed: %s') % str(e))
        return True

    def create_print_job(self, destination_id, document_type, payload, odoo_model=None, odoo_record_id=None, report_xml_id=None, report_name=None, report_id=None, idempotency_key=None):
        """Helper to create a Gateway print job from Odoo business logic.
        Resolves branch/destination/document_type and sends to Gateway.
        Never hardcodes physical printer IDs.
        Stores Odoo report metadata for tracing.
        Idempotency: one logical Odoo print operation must produce ONE stable
        idempotency key. The key is generated once per logical operation
        (uuid4) and reused on retry so a timeout/retry never creates a
        duplicate physical print. Gateway enforces uniqueness via
        PostgreSQL partial unique index on (branch_id, idempotency_key)
        and handles concurrent duplicate inserts as 200 with the same
        existing job returned. The jobId itself is a collision-safe
        nanoid(12) and never truncated.
        """
        self.ensure_one()
        # SECURITY: Verify user has access to this branch's company
        self._check_company_access()
        if not destination_id or not document_type:
            raise ValidationError(_('destination and document_type required'))
        headers = self._gateway_headers()
        base = self._gateway_base()
        # Stable idempotency key per logical operation. Caller (ir_actions_report)
        # should generate it once per report_action invocation; if not provided
        # we generate one here so every job is still idempotent against retries.
        if not idempotency_key:
            idempotency_key = uuid.uuid4().hex
        # Gateway IDs are string columns. Odoo int ids (record ids) MUST be
        # stringified here: a bare int in JSON would make the Gateway's
        # branchId/destinationId comparisons fail against its text columns
        # (mismatch with branch-scoped API keys, routing 404, FK-less
        # destination lookup). If sync ran, gateway_destination_id carries the
        # id the Gateway stored for the Odoo destination; otherwise the Odoo
        # record id is the stable id sent to the Gateway (sync creates it).
        data = {
            'branchId': str(self.gateway_branch_id or self.id),
            'destinationId': str(destination_id),
            'documentType': document_type,
            'payload': payload,
            'idempotencyKey': idempotency_key,
        }
        # Idempotent retry: reuse same idempotencyKey so second attempt
        # returns existing job (200) rather than creating duplicate.
        last_exc = None
        for attempt in (1, 2):
            try:
                resp = requests.post(f"{base}/api/print/jobs", json=data, headers=headers, timeout=15)
                break
            except (requests.Timeout, requests.ConnectionError) as e:
                last_exc = e
                if attempt == 1:
                    _logger.warning("Print job POST timeout/connection error (attempt %s) for branch %s, retrying once with same idempotencyKey %s: %s", attempt, self.name, idempotency_key[:8], str(e))
                    time.sleep(0.5)
                    continue
                raise ValidationError(_('Print job failed: Gateway timeout/connection error after retry: %s') % str(e))
            except requests.RequestException as e:
                raise ValidationError(_('Print job request failed: %s') % str(e))
        else:
            # Should not reach here; last_exc is set
            raise ValidationError(_('Print job failed: %s') % str(last_exc))
        if resp.status_code not in (200, 201):
            raise ValidationError(_('Print job failed %s: %s') % (resp.status_code, resp.text[:500]))
        j = resp.json()
        # Resolve report_id if provided as xml_id
        report_rec_id = False
        if report_id:
            report_rec_id = report_id
        elif report_xml_id:
            try:
                # report_xml_id may be like 'sale.action_report_saleorder'
                if '.' in report_xml_id:
                    report_rec = self.env.ref(report_xml_id, raise_if_not_found=False)
                    if report_rec and report_rec._name == 'ir.actions.report':
                        report_rec_id = report_rec.id
            except Exception:
                pass
        # Create local tracking record with full metadata (payload stored as metadata, not huge binary in DB)
        # Do not store full binary payload if huge; store truncated metadata
        payload_meta = str(payload)[:2000] if payload else ''
        # destination_id is a string (gateway id when synced) or an Odoo int
        # record id. gateway_destination_id is only populated by explicit
        # admin input, so fall back to the Odoo destination record itself
        # when the gateway-id search finds nothing.
        dest = self.env['print_gateway.destination'].search(
            [('gateway_destination_id', '=', str(destination_id))], limit=1)
        if not dest:
            try:
                odoo_id = int(destination_id)
            except (TypeError, ValueError):
                odoo_id = 0
            if odoo_id > 0:
                candidate = self.env['print_gateway.destination'].browse(odoo_id)
                dest = candidate.exists()
            else:
                dest = False
        job = self.env['print_gateway.print_job'].create({
            'branch_id': self.id,
            'gateway_job_id': j.get('jobId') or j.get('id'),
            'destination_id': dest.id if dest else False,
            'document_type': document_type,
            'printer_id': self.env['print_gateway.printer'].search([('gateway_printer_id', '=', j.get('printerId'))], limit=1).id or False,
            'status': j.get('status') or 'queued',
            'payload': payload_meta,
            'idempotency_key': idempotency_key,
            'odoo_model': odoo_model or False,
            'odoo_record_id': odoo_record_id or False,
            'report_xml_id': report_xml_id or False,
            'report_name': report_name or False,
            'report_id': report_rec_id,
        })
        return job
