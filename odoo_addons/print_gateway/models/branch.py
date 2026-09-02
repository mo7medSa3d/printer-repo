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
    # Printers reach the branch through their agent; this one2many uses the
    # printer's stored *related* branch column (agent_id.branch_id) purely as an
    # index, so it always agrees with agent ownership.
    printer_ids = fields.One2many('print_gateway.printer', 'branch_id', string='Printers', readonly=True)
    document_type_ids = fields.One2many('print_gateway.document_type', 'branch_id', string='Document Types')
    binding_ids = fields.One2many('print_gateway.printer_binding', 'branch_id', string='Printer Bindings')
    agent_ids = fields.One2many('print_gateway.agent', 'branch_id', string='Agents')

    agent_count = fields.Integer(compute='_compute_counts', string='Agents Online')
    printer_count = fields.Integer(compute='_compute_counts', string='Printers Total')
    last_sync_at = fields.Datetime(string='Last Sync At', readonly=True)
    last_sync_status = fields.Selection([
        ('success', 'Success'),
        ('failed', 'Failed'),
        ('partial', 'Partial'),
    ], string='Last Sync Status', readonly=True, copy=False)
    last_sync_error = fields.Text(string='Last Sync Error', readonly=True, copy=False)

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
        """Pull agents and printers from the Gateway (Gateway -> Odoo). Idempotent.

        Ownership mirrored exactly as the Gateway models it:

            Branch -> Agent -> Printer

        Agents are synced FIRST because a printer cannot exist in Odoo without
        its owning agent (``agent_id`` is required and the printer's branch is
        derived from it). Consequences handled explicitly here:

        * new agent            -> created in this branch
        * reassigned agent     -> the SAME Odoo agent record is moved to this
                                  branch; all of its printers follow, because
                                  ``printer.branch_id`` is related to
                                  ``agent_id.branch_id``. Nothing is duplicated.
        * new printer          -> created under its agent (branch derived)
        * reassigned printer   -> ``agent_id`` rewritten; the branch follows
        * duplicate/legacy id  -> matched by GLOBAL ``gateway_printer_id`` /
                                  ``gateway_agent_id``, so the same runtime
                                  object can never be mirrored twice in two
                                  branches
        * printer whose agent  -> skipped with a warning rather than being
          is unknown              attached to an arbitrary agent
        * removed/stale        -> marked offline+disabled (never deleted, so
          printers                bindings and job history keep their FKs)
        * cross-branch record  -> never silently merged; a mirror row whose
                                  agent now belongs elsewhere simply moves with
                                  its agent
        """
        Agent = self.env['print_gateway.agent']
        Printer = self.env['print_gateway.printer']
        for branch in self:
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                # Gateway ids are strings; Odoo record ids must be stringified
                # before they are used as branchId query params (the Gateway
                # compares them against text columns and branch-scoped keys).
                gateway_branch_id = str(branch.gateway_branch_id or branch.id)

                # ---------------------------------------------------- agents
                agent_by_gateway_id = {}
                resp = requests.get(f"{base}/api/odoo/agents", params={'branchId': gateway_branch_id}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for ag in resp.json():
                        gw_agent_id = ag.get('id')
                        if not gw_agent_id:
                            continue
                        # Global lookup: the runtime agent is one object. If it
                        # was reassigned in the Gateway, we MOVE the existing
                        # mirror instead of creating a second one in this branch.
                        existing = Agent.search([('gateway_agent_id', '=', gw_agent_id)], limit=1)
                        vals = {
                            'branch_id': branch.id,
                            'gateway_agent_id': gw_agent_id,
                            'name': ag.get('name') or gw_agent_id,
                            'status': ag.get('status') or 'unknown',
                            'last_seen_at': ag.get('lastSeenAt'),
                            'hostname': (ag.get('metadata') or {}).get('hostname') if isinstance(ag.get('metadata'), dict) else ag.get('hostname'),
                            'os': (ag.get('metadata') or {}).get('os') if isinstance(ag.get('metadata'), dict) else ag.get('os'),
                        }
                        if existing:
                            if existing.branch_id.id != branch.id:
                                _logger.info(
                                    "Agent %s moved from branch %s to %s; its %s printer(s) move with it",
                                    gw_agent_id, existing.branch_id.display_name, branch.name, len(existing.printer_ids))
                            existing.write(vals)
                            agent_by_gateway_id[gw_agent_id] = existing
                        else:
                            agent_by_gateway_id[gw_agent_id] = Agent.create(vals)

                # -------------------------------------------------- printers
                seen_printer_ids = []
                resp = requests.get(f"{base}/api/odoo/printers", params={'branchId': gateway_branch_id}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for pr in resp.json():
                        gw_printer_id = pr.get('id')
                        if not gw_printer_id:
                            continue
                        gw_agent_id = pr.get('agentId') or pr.get('agent_id')
                        agent = agent_by_gateway_id.get(gw_agent_id)
                        if not agent and gw_agent_id:
                            agent = Agent.search([('gateway_agent_id', '=', gw_agent_id)], limit=1)
                        if not agent:
                            # A printer with no resolvable agent has no branch.
                            # Do NOT attach it to an arbitrary agent/branch.
                            _logger.warning(
                                "Printer %s references unknown agent %s; skipped (its branch is derived through the agent)",
                                gw_printer_id, gw_agent_id)
                            continue
                        # Global lookup for the same reason as agents: one
                        # physical printer, one mirror record.
                        existing = Printer.search([('gateway_printer_id', '=', gw_printer_id)], limit=1)
                        vals = {
                            # No branch_id is written: it is a stored related
                            # field on agent_id.branch_id and follows the agent.
                            'agent_id': agent.id,
                            'gateway_printer_id': gw_printer_id,
                            'name': pr.get('name') or gw_printer_id,
                            'printer_type': pr.get('printerType') or pr.get('printer_type') or 'unknown',
                            'connection_type': pr.get('connectionType') or pr.get('connection_type') or 'tcp',
                            'protocol': pr.get('protocol') or 'raw',
                            'status': pr.get('status') or 'unknown',
                            'enabled': pr.get('enabled', True),
                            'last_seen_at': pr.get('lastSeenAt') or False,
                        }
                        # Extract config
                        cfg = pr.get('config') or {}
                        vals.update({
                            'ip_address': cfg.get('ip'),
                            'port': cfg.get('port'),
                            'spooler_name': cfg.get('spooler_name'),
                        })
                        if existing:
                            if existing.agent_id.id != agent.id:
                                _logger.info(
                                    "Printer %s reassigned from agent %s to %s (branch %s -> %s)",
                                    gw_printer_id, existing.agent_id.display_name, agent.display_name,
                                    existing.branch_id.display_name, agent.branch_id.display_name)
                            existing.write(vals)
                            seen_printer_ids.append(existing.id)
                        else:
                            seen_printer_ids.append(Printer.create(vals).id)

                    # Stale mirrors: printers this branch's agents used to own
                    # but the Gateway no longer reports. They are marked
                    # offline + disabled, never deleted — bindings and print
                    # job history must keep their foreign keys, and an operator
                    # must be able to see what disappeared.
                    stale = Printer.search([
                        ('branch_id', '=', branch.id),
                        ('id', 'not in', seen_printer_ids),
                    ])
                    if stale:
                        _logger.info("Marking %s stale printer mirror(s) offline in branch %s", len(stale), branch.name)
                        stale.write({'status': 'offline', 'enabled': False})

                branch.last_sync_at = fields.Datetime.now()
                _logger.info("Branch %s sync from gateway completed", branch.name)
            except requests.RequestException as e:
                _logger.error("Branch %s sync failed: %s", branch.name, str(e))
                raise ValidationError(_('Sync failed: %s') % str(e))
        return True

    def action_sync_to_gateway(self):
        """Push branches/destinations/document_types/bindings to Gateway (Odoo -> Gateway).

        Each branch is an independent HTTP call against a separate database.
        There is no distributed transaction: Branch A succeeding and Branch B
        failing is recorded per-branch (last_sync_status/last_sync_error) so a
        retry converges without claiming atomicity across branches.
        """
        errors = []
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
                    'documentTypes': [{
                        'id': str(dt.gateway_document_type_id or dt.id),
                        'branchId': str(branch.gateway_branch_id or branch.id),
                        'name': dt.name,
                        'description': dt.description,
                        'enabled': dt.enabled,
                    } for dt in branch.document_type_ids],
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
                    raise ValidationError(_('Gateway sync failed %s: %s') % (resp.status_code, branch._format_sync_error(resp)))
                _logger.info("Branch %s sync to gateway OK: %s", branch.name, resp.text[:500])
                branch.write({
                    'last_sync_at': fields.Datetime.now(),
                    'last_sync_status': 'success',
                    'last_sync_error': False,
                })
            except Exception as e:
                # Persist the failure so a partial multi-branch sync is
                # detectable and retryable. Do not stop remaining branches.
                err = str(e)
                _logger.error("Branch %s sync to gateway failed: %s", branch.name, err)
                try:
                    branch.write({
                        'last_sync_status': 'failed',
                        'last_sync_error': err[:2000],
                    })
                except Exception:
                    _logger.warning("Could not persist sync failure for branch %s", branch.name)
                errors.append('%s: %s' % (branch.name, err))
        if errors:
            raise ValidationError(_('Sync partially failed (%s of %s branches):\n%s') % (
                len(errors), len(self), '\n'.join('- %s' % e for e in errors)))
        return True

    @staticmethod
    def _format_sync_error(resp):
        """Turn the Gateway's structured sync error into a readable message.

        The Gateway answers a rejected sync with
        {"success": false, "error": "SYNC_VALIDATION_FAILED" |
        "SYNC_DEPENDENCY_MISSING", "details": [{bindingId, printerId, reason}]}
        and applies nothing at all. Showing the raw JSON blob hides which
        binding is at fault, so the details are expanded here.
        """
        try:
            body = resp.json()
        except ValueError:
            return resp.text[:500]
        if not isinstance(body, dict):
            return resp.text[:500]
        code = body.get('error') or 'UNKNOWN_ERROR'
        details = body.get('details') or []
        lines = []
        for item in details:
            if not isinstance(item, dict):
                lines.append(str(item))
                continue
            parts = []
            for key in ('entity', 'bindingId', 'id', 'destinationId', 'printerId'):
                value = item.get(key)
                if value:
                    parts.append('%s=%s' % (key, value))
            reason = item.get('reason') or ''
            lines.append('%s: %s' % (', '.join(parts), reason) if parts else reason)
        message = body.get('message')
        if message:
            lines.append(str(message))
        if lines:
            return '%s\n%s' % (code, '\n'.join('- %s' % line for line in lines))
        return code

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

        # Resolve destination and persist the operation ID BEFORE the HTTP
        # call so a timeout after Gateway acceptance retries with the same
        # key instead of minting a second logical job.
        dest = self.env['print_gateway.destination'].search([
            ('gateway_destination_id', '=', str(destination_id)),
            ('branch_id', '=', self.id),
        ], limit=1)
        if not dest:
            try:
                odoo_id = int(destination_id)
            except (TypeError, ValueError):
                odoo_id = 0
            if odoo_id > 0:
                candidate = self.env['print_gateway.destination'].browse(odoo_id)
                if candidate.exists() and candidate.branch_id.id == self.id:
                    dest = candidate
                else:
                    dest = False
            else:
                dest = False

        payload_meta = str(payload)[:2000] if payload else ''
        Job = self.env['print_gateway.print_job']
        existing = Job.search([
            ('branch_id', '=', self.id),
            ('idempotency_key', '=', idempotency_key),
        ], limit=1)
        if not existing:
            vals = {
                'branch_id': self.id,
                'gateway_job_id': False,
                'destination_id': dest.id if dest else False,
                'document_type': document_type,
                'status': 'queued',
                'payload': payload_meta,
                'idempotency_key': idempotency_key,
                'odoo_model': odoo_model or False,
                'odoo_record_id': odoo_record_id or False,
                'report_xml_id': report_xml_id or False,
                'report_name': report_name or False,
            }
            # Unique (branch_id, idempotency_key) is the concurrent-safety
            # gate on the Odoo side. Two workers that both miss the search
            # collide here; the loser re-reads the winner inside a savepoint
            # so the surrounding transaction is not aborted.
            try:
                with self.env.cr.savepoint():
                    existing = Job.create(vals)
            except Exception:
                existing = Job.search([
                    ('branch_id', '=', self.id),
                    ('idempotency_key', '=', idempotency_key),
                ], limit=1)
                if not existing:
                    raise
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
        existing.write({
            'gateway_job_id': j.get('jobId') or j.get('id') or existing.gateway_job_id,
            'destination_id': dest.id if dest else existing.destination_id,
            'document_type': document_type,
            'printer_id': self.env['print_gateway.printer'].search([('gateway_printer_id', '=', j.get('printerId'))], limit=1).id or existing.printer_id,
            'status': j.get('status') or existing.status or 'queued',
            'payload': payload_meta or existing.payload,
            'odoo_model': odoo_model or existing.odoo_model,
            'odoo_record_id': odoo_record_id or existing.odoo_record_id,
            'report_xml_id': report_xml_id or existing.report_xml_id,
            'report_name': report_name or existing.report_name,
            'report_id': report_rec_id or existing.report_id,
        })
        return existing
