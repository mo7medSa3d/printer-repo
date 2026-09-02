# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
from odoo.exceptions import ValidationError
import requests
import logging
import time
import uuid
import json

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
    printer_ids = fields.Many2many('print_gateway.printer', compute='_compute_printers', string='Printers', readonly=True)
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
    last_successful_sync_at = fields.Datetime(string='Last Successful Sync', readonly=True, copy=False)

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

    @api.depends('agent_ids', 'agent_ids.status')
    def _compute_counts(self):
        for rec in self:
            rec.agent_count = len(rec.agent_ids.filtered(lambda a: a.status == 'online'))
            rec.printer_count = self.env['print_gateway.printer'].search_count([('agent_id.branch_id', '=', rec.id)])

    @api.depends('agent_ids', 'agent_ids.printer_ids')
    def _compute_printers(self):
        Printer = self.env['print_gateway.printer']
        for rec in self:
            rec.printer_ids = Printer.search([('agent_id.branch_id', '=', rec.id)])

    def unlink(self):
        raise ValidationError(_('Branches are lifecycle/configuration roots and cannot be physically deleted. Disable the branch or decommission it explicitly.'))

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

    def cron_retry_pending_print_jobs(self):
        """Retry persisted Odoo print operations that have no Gateway job id.

        The persisted idempotency_key is the logical operation identity, so a
        process restart can retry safely without minting a second operation.
        A new manual print creates a separate print_job row/key.
        """
        Job = self.env['print_gateway.print_job']
        pending = Job.search([('gateway_job_id', '=', False), ('status', '=', 'queued')], order='id asc', limit=100)
        retried = 0
        for job in pending: 
            try:
                job.action_submit_pending()
                retried += 1
            except Exception as exc:
                _logger.warning("Pending Gateway print retry failed for operation %s: %s", job.id, str(exc))
        return retried

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

    def _gateway_get_json(self, url, headers, params=None, timeout=10):
        """GET a JSON Gateway endpoint with strict transport semantics."""
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            raise ValidationError(_('Gateway request failed: %s') % str(exc))
        if not 200 <= resp.status_code < 300:
            raise ValidationError(_('Gateway returned HTTP %s: %s') % (resp.status_code, self._format_sync_error(resp)))
        try:
            body = resp.json()
        except ValueError as exc:
            raise ValidationError(_('Gateway returned malformed JSON: %s') % str(exc))
        if not isinstance(body, (list, dict)):
            raise ValidationError(_('Gateway returned an invalid JSON payload'))
        return body

    def action_sync_from_gateway(self):
        """Pull runtime state in dependency order: Agents, then Printers.

        Agents are required. Printer state is an optional runtime section for
        status visibility, so an agent-success/printer-failure run is marked
        partial rather than falsely successful. No failed HTTP response is
        interpreted as success and no ownership relationship is guessed.
        """
        errors = []
        for branch in self:
            started = fields.Datetime.now()
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                gateway_branch_id = str(branch.gateway_branch_id or branch.id)

                agents_data = branch._gateway_get_json(
                    f"{base}/api/odoo/agents",
                    headers,
                    params={'branchId': gateway_branch_id},
                )
                if not isinstance(agents_data, list):
                    raise ValidationError(_('Agents endpoint must return an array'))

                Agent = branch.env['print_gateway.agent']
                with branch.env.cr.savepoint():
                    for ag in agents_data:
                        gateway_id = ag.get('id')
                        if not isinstance(gateway_id, str) or not gateway_id.strip():
                            raise ValidationError(_('Agents endpoint returned an invalid agent id'))
                        existing = Agent.search([('gateway_agent_id', '=', gateway_id)], limit=1)
                        if ag.get('lifecycle') not in ('active', 'disabled', 'retired'):
                            raise ValidationError(_('Agent %s has missing or invalid lifecycle') % gateway_id)
                        vals = {
                            'branch_id': branch.id,
                            'gateway_agent_id': gateway_id,
                            'name': (ag.get('name') or gateway_id)[:255],
                            'status': ag.get('status') or 'unknown',
                            'lifecycle': ag.get('lifecycle'),
                            'last_seen_at': ag.get('lastSeenAt') or False,
                        }
                        if existing:
                            if existing.branch_id != branch:
                                raise ValidationError(_('Agent %s belongs to another Odoo branch') % gateway_id)
                            existing.write(vals)
                        else:
                            Agent.create(vals)

                printer_error = None
                try:
                    printers_data = branch._gateway_get_json(
                        f"{base}/api/odoo/printers",
                        headers,
                        params={'branchId': gateway_branch_id},
                    )
                    if not isinstance(printers_data, list):
                        raise ValidationError(_('Printers endpoint must return an array'))
                    Printer = branch.env['print_gateway.printer']
                    for pr in printers_data:
                        printer_id = pr.get('id')
                        agent_id = pr.get('agentId')
                        if not isinstance(printer_id, str) or not printer_id.strip():
                            raise ValidationError(_('Printers endpoint returned an invalid printer id'))
                        if not isinstance(agent_id, str) or not agent_id.strip():
                            raise ValidationError(_('Printer %s has no owning agent') % printer_id)
                        agent = Agent.search([('gateway_agent_id', '=', agent_id)], limit=1)
                        if not agent:
                            raise ValidationError(_('Printer %s references an agent not present in the synchronized branch') % printer_id)
                        if agent.branch_id != branch:
                            raise ValidationError(_('Printer %s agent belongs to another branch') % printer_id)
                        existing = Printer.search([('gateway_printer_id', '=', printer_id)], limit=1)
                        if pr.get('printerType') not in ('physical', 'virtual', 'redirected'):
                            raise ValidationError(_('Printer %s has missing or invalid printerType') % printer_id)
                        if pr.get('deviceClass') not in ('thermal', 'laser', 'inkjet', 'label', 'other', 'unknown'):
                            raise ValidationError(_('Printer %s has missing or invalid deviceClass') % printer_id)
                        if pr.get('connectionType') not in ('network', 'usb', 'spooler', 'ipp', 'ipps'):
                            raise ValidationError(_('Printer %s has missing or invalid connectionType') % printer_id)
                        if pr.get('protocol') not in ('raw', 'escpos', 'ipp', 'ipps', 'spooler'):
                            raise ValidationError(_('Printer %s has missing or invalid protocol') % printer_id)
                        if pr.get('lifecycle') not in ('active', 'disabled', 'retired'):
                            raise ValidationError(_('Printer %s has missing or invalid lifecycle') % printer_id)
                        vals = {
                            'agent_id': agent.id,
                            'gateway_printer_id': printer_id,
                            'name': pr.get('name') or printer_id,
                            'printer_type': pr.get('printerType'),
                            'device_class': pr.get('deviceClass'),
                            'connection_type': pr.get('connectionType'),
                            'protocol': pr.get('protocol'),
                            'status': pr.get('status') or 'unknown',
                            'lifecycle': pr.get('lifecycle'),
                        }
                        cfg = pr.get('config') or {}
                        vals.update({
                            'ip_address': cfg.get('ip'),
                            'port': cfg.get('port'),
                            'spooler_name': cfg.get('spooler_name'),
                        })
                        if existing:
                            if existing.agent_id.branch_id != branch:
                                raise ValidationError(_('Printer %s belongs to another branch') % printer_id)
                            existing.write(vals)
                        else:
                            Printer.create(vals)
                except Exception as exc:
                    printer_error = str(exc)

                completed = fields.Datetime.now()
                if printer_error:
                    branch.write({
                        'last_sync_at': completed,
                        'last_sync_status': 'partial',
                        'last_sync_error': printer_error[:2000],
                    })
                    errors.append('%s: partial (%s)' % (branch.name, printer_error))
                else:
                    branch.write({
                        'last_sync_at': completed,
                        'last_sync_status': 'success',
                        'last_sync_error': False,
                        'last_successful_sync_at': completed,
                    })
                    _logger.info("Branch %s sync from gateway completed", branch.name)
            except Exception as exc:
                err = str(exc)
                completed = fields.Datetime.now()
                branch.write({
                    'last_sync_at': completed,
                    'last_sync_status': 'failed',
                    'last_sync_error': err[:2000],
                })
                _logger.error("Branch %s sync from gateway failed: %s", branch.name, err)
                errors.append('%s: failed (%s)' % (branch.name, err))
        if errors:
            raise ValidationError(_('Gateway pull sync did not fully succeed:\n%s') % '\n'.join('- %s' % e for e in errors))
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
                        'payloadHint': dt.payload_hint or False,
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
                try:
                    result = resp.json()
                except ValueError:
                    raise ValidationError(_('Gateway returned malformed JSON for sync response'))
                if not isinstance(result, dict) or result.get('success') is not True:
                    raise ValidationError(_('Gateway returned a non-success sync result'))
                _logger.info("Branch %s sync to gateway OK", branch.name)
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
                        'last_sync_at': fields.Datetime.now(),
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

    def create_print_job(self, destination_id, document_type, payload, odoo_model=None, odoo_record_id=None, report_xml_id=None, report_name=None, report_id=None, idempotency_key=None, defer_until_commit=False):
        """Helper to create a Gateway print job from Odoo business logic.
        Resolves branch/destination/document_type and sends to Gateway.
        Never hardcodes physical printer IDs.
        Stores Odoo report metadata for tracing.
        Idempotency: one persisted print_job row represents one logical Odoo
        print operation. Its idempotency key is generated exactly once when
        that local operation is created and is reused by all gateway retries.
        A genuinely new manual print creates a new local print_job and therefore
        a new key. Gateway enforces uniqueness via
        PostgreSQL partial unique index on (branch_id, idempotency_key)
        and handles concurrent duplicate inserts as 200 with the same
        existing job returned. The jobId itself is a collision-safe
        nanoid(12) and never truncated.

        When ``defer_until_commit`` is true, this method implements the
        outbox boundary used by Odoo report actions: the durable logical
        operation is created in the current transaction, and the Gateway HTTP
        call is registered as a post-commit callback using a fresh cursor.
        A process crash before the callback runs leaves a queued row that the
        scheduled retry worker can submit with the same idempotency key.
        """
        self.ensure_one()
        # SECURITY: Verify user has access to this branch's company
        self._check_company_access()
        if not destination_id or not document_type:
            raise ValidationError(_('destination and document_type required'))
        headers = self._gateway_headers()
        base = self._gateway_base()
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

        try:
            payload_meta = json.dumps(payload, separators=(',', ':'), ensure_ascii=False) if payload is not None else ''
        except (TypeError, ValueError) as exc:
            raise ValidationError(_('Print payload is not JSON serializable')) from exc
        if len(payload_meta.encode('utf-8')) > 8 * 1024 * 1024:
            raise ValidationError(_('Print payload is too large to persist safely (maximum 8 MiB serialized)'))
        Job = self.env['print_gateway.print_job']
        if not idempotency_key:
            idempotency_key = uuid.uuid4().hex

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
        if defer_until_commit:
            registry = self.env.registry
            dbname = self.env.cr.dbname
            uid = self.env.uid
            context = dict(self.env.context)
            operation_id = existing.id

            def _submit_after_commit():
                try:
                    with registry.cursor() as cr:
                        env = api.Environment(cr, uid, context)
                        operation = env['print_gateway.print_job'].browse(operation_id).exists()
                        if not operation:
                            return
                        operation.action_submit_pending()
                        cr.commit()
                except Exception as exc:
                    # The local outbox row remains durable. The scheduled
                    # retry job will submit the same idempotency key later.
                    _logger.error(
                        "Post-commit Gateway submission failed for operation %s on db %s: %s",
                        operation_id, dbname, str(exc), exc_info=True,
                    )

            self.env.cr.postcommit.add(_submit_after_commit)
            return existing

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
        try:
            j = resp.json()
        except ValueError:
            raise ValidationError(_('Gateway returned malformed JSON for print job response'))
        if not isinstance(j, dict) or not (j.get('jobId') or j.get('id')):
            raise ValidationError(_('Gateway returned an invalid print job response'))
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
