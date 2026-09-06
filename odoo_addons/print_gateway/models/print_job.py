# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
import requests
import logging
import json
import time

_logger = logging.getLogger(__name__)


class PrintGatewayPrintJob(models.Model):
    _name = 'print_gateway.print_job'
    _description = 'Print Gateway Job'
    _order = 'create_date desc'

    gateway_job_id = fields.Char(string='Gateway Job ID', copy=False, index=True, help='Filled once the Gateway accepts the job. Empty while the operation is persisted locally pending the HTTP round-trip.')
    branch_id = fields.Many2one('print_gateway.branch', required=True, ondelete='restrict')
    destination_id = fields.Many2one('print_gateway.destination', ondelete='set null')
    document_type = fields.Char()
    printer_id = fields.Many2one('print_gateway.printer', ondelete='set null')
    agent_id = fields.Many2one('print_gateway.agent', ondelete='set null')
    status = fields.Selection([('queued', 'Queued'), ('claimed', 'Claimed'), ('printing', 'Printing'), ('success', 'Success'), ('failed', 'Failed'), ('expired', 'Expired')], default='queued', index=True)
    payload = fields.Text(help='Full canonical print payload serialized as JSON; retained for durable retry. Never logged or exposed in operational logs.')
    error = fields.Text()
    requested_by = fields.Char(default='odoo')
    idempotency_key = fields.Char(string='Idempotency Key', copy=False, index=True, help='Stable per logical print operation; reused on retry to avoid duplicate physical prints')
    create_date = fields.Datetime(string='Created At', readonly=True)
    write_date = fields.Datetime(string='Updated At', readonly=True)
    last_sync_at = fields.Datetime(readonly=True)
    odoo_model = fields.Char(string='Odoo Model', help='Model of printed record, e.g., sale.order', index=True)
    odoo_record_id = fields.Integer(string='Odoo Record ID', help='ID of printed record')
    report_xml_id = fields.Char(string='Report XML ID', help='e.g., sale.action_report_saleorder', index=True)
    report_name = fields.Char(string='Report Name', help='Technical report name, e.g., sale.report_saleorder_document')
    report_id = fields.Many2one('ir.actions.report', string='Report', ondelete='set null')

    _branch_idempotency_unique = models.Constraint(
        'UNIQUE(branch_id, idempotency_key)',
        'This print operation was already submitted for this branch.',
    )

    _VALID_GATEWAY_STATUSES = frozenset({'queued', 'claimed', 'printing', 'success', 'failed', 'expired', 'completed'})
    _TERMINAL_GATEWAY_STATUSES = frozenset({'success', 'failed', 'expired'})

    @classmethod
    def _normalize_gateway_status(cls, status):
        if not isinstance(status, str):
            return None
        normalized = status.strip().lower()
        if normalized == 'completed':
            normalized = 'success'
        return normalized if normalized in cls._VALID_GATEWAY_STATUSES - {'completed'} else None

    @classmethod
    def _should_accept_status_update(cls, current_status, remote_status):
        """Never allow a remote read to regress a terminal local result."""
        normalized = cls._normalize_gateway_status(remote_status)
        if normalized is None:
            return None
        if current_status in cls._TERMINAL_GATEWAY_STATUSES:
            return normalized if normalized == current_status else None
        return normalized

    def action_submit_pending(self):
        """Submit an already-persisted logical operation using its original key."""
        for job in self:
            if job.gateway_job_id:
                continue
            if not job.idempotency_key:
                raise ValueError("Pending print operation is missing its idempotency key")
            if not job.branch_id or not job.destination_id:
                raise ValueError("Pending print operation has incomplete routing")
            payload_raw = job.payload or ''
            try:
                payload_obj = json.loads(payload_raw)
            except (TypeError, ValueError) as exc:
                raise ValueError("Persisted print payload is invalid JSON; refusing to retry an ambiguous operation") from exc
            result = job.branch_id.create_print_job(
                job.destination_id.gateway_destination_id or job.destination_id.id,
                job.document_type,
                payload_obj,
                odoo_model=job.odoo_model,
                odoo_record_id=job.odoo_record_id,
                report_xml_id=job.report_xml_id,
                report_name=job.report_name,
                report_id=job.report_id.id if job.report_id else None,
                idempotency_key=job.idempotency_key,
            )
            if result.gateway_job_id and result.gateway_job_id != job.gateway_job_id:
                normalized = self._normalize_gateway_status(result.status)
                job.write({
                    'gateway_job_id': result.gateway_job_id,
                    'status': normalized or job.status,
                    'last_sync_at': fields.Datetime.now(),
                    'error': False,
                })
        return True

    def action_sync_status(self):
        for job in self:
            if not job.gateway_job_id:
                continue
            try:
                branch = job.branch_id
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                resp = requests.get(
                    f"{base}/api/print/jobs",
                    params={'id': job.gateway_job_id},
                    headers=headers,
                    timeout=10,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    remote_status = data.get('status') or data.get('state')
                    accepted_status = self._should_accept_status_update(job.status, remote_status)
                    vals = {'error': data.get('error'), 'last_sync_at': fields.Datetime.now()}
                    if accepted_status is not None:
                        vals['status'] = accepted_status
                    elif remote_status is not None:
                        _logger.warning(
                            "Ignoring invalid or regressive Gateway status for job %s: local=%s remote=%s",
                            job.gateway_job_id,
                            job.status,
                            remote_status,
                        )
                    job.write(vals)
                else:
                    _logger.warning("Job %s status sync returned %s", job.gateway_job_id, resp.status_code)
            except Exception as e:
                _logger.warning("Job %s sync failed: %s", job.gateway_job_id, str(e))
        return True

    @api.model
    def cron_sync_pending_jobs(self):
        """Bounded, batched Gateway status reconciliation.

        Only a bounded number of local rows are processed per invocation.
        Jobs are grouped by branch and fetched through the Gateway's batched
        ``/api/odoo/sync?jobIds=...`` endpoint, avoiding one HTTP request per
        job. A hard wall-clock budget prevents a degraded Gateway from holding
        an Odoo cron worker indefinitely.
        """
        max_jobs = 100
        max_branches = 20
        max_runtime_seconds = 30
        request_timeout_seconds = 5
        started = time.monotonic()

        pending = self.search(
            [('status', 'in', ['queued', 'claimed', 'printing']), ('gateway_job_id', '!=', False)],
            order='id asc',
            limit=max_jobs,
        )
        if not pending:
            return 0

        grouped = {}
        for job in pending:
            grouped.setdefault(job.branch_id.id, self.env['print_gateway.print_job'])
            grouped[job.branch_id.id] |= job

        synced = 0
        branches_processed = 0
        for branch_id, jobs in grouped.items():
            if branches_processed >= max_branches or (time.monotonic() - started) >= max_runtime_seconds:
                break
            branches_processed += 1
            branch = self.env['print_gateway.branch'].browse(branch_id)
            try:
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                gateway_branch_id = str(branch.gateway_branch_id or branch.id)
                job_ids = [job.gateway_job_id for job in jobs if job.gateway_job_id]
                if not job_ids:
                    continue

                response = requests.get(
                    f"{base}/api/odoo/sync",
                    params={'branchId': gateway_branch_id, 'jobIds': ','.join(job_ids[:50])},
                    headers=headers,
                    timeout=request_timeout_seconds,
                )
                if response.status_code != 200:
                    _logger.warning(
                        "Batched Gateway status sync for branch %s returned HTTP %s",
                        branch.name,
                        response.status_code,
                    )
                    continue

                data = response.json()
                rows = data.get('jobs') if isinstance(data, dict) else None
                if not isinstance(rows, list):
                    _logger.warning("Gateway batch status response for branch %s has invalid jobs shape", branch.name)
                    continue

                by_gateway_id = {
                    row.get('id'): row
                    for row in rows
                    if isinstance(row, dict) and isinstance(row.get('id'), str)
                }
                for job in jobs:
                    row = by_gateway_id.get(job.gateway_job_id)
                    if row is None:
                        continue
                    remote_status = row.get('status') or row.get('state')
                    accepted_status = self._should_accept_status_update(job.status, remote_status)
                    vals = {
                        'error': row.get('error'),
                        'last_sync_at': fields.Datetime.now(),
                    }
                    if accepted_status is not None:
                        vals['status'] = accepted_status
                    elif remote_status is not None:
                        _logger.warning(
                            "Ignoring invalid or regressive batched Gateway status for job %s: local=%s remote=%s",
                            job.gateway_job_id,
                            job.status,
                            remote_status,
                        )
                    job.write(vals)
                    synced += 1
            except (requests.RequestException, ValueError, TypeError) as exc:
                _logger.warning("Batched Gateway status sync failed for branch %s: %s", branch.name, str(exc))
            except Exception as exc:
                _logger.warning("Unexpected batched Gateway status sync failure for branch %s: %s", branch.name, str(exc))

        return synced
