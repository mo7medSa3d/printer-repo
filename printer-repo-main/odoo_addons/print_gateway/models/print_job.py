# -*- coding: utf-8 -*-
from odoo import models, fields, api, _
import requests
import logging

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
    status = fields.Selection([
        ('queued', 'Queued'),
        ('claimed', 'Claimed'),
        ('printing', 'Printing'),
        ('success', 'Success'),
        ('failed', 'Failed'),
        ('expired', 'Expired'),
    ], default='queued', index=True)
    payload = fields.Text(help='Base64 payload or description')
    error = fields.Text()
    requested_by = fields.Char(default='odoo')
    idempotency_key = fields.Char(string='Idempotency Key', copy=False, index=True, help='Stable per logical print operation; reused on retry to avoid duplicate physical prints')
    create_date = fields.Datetime(string='Created At', readonly=True)
    write_date = fields.Datetime(string='Updated At', readonly=True)
    last_sync_at = fields.Datetime(readonly=True)
    # Generic report tracking fields
    odoo_model = fields.Char(string='Odoo Model', help='Model of printed record, e.g., sale.order', index=True)
    odoo_record_id = fields.Integer(string='Odoo Record ID', help='ID of printed record')
    report_xml_id = fields.Char(string='Report XML ID', help='e.g., sale.action_report_saleorder', index=True)
    report_name = fields.Char(string='Report Name', help='Technical report name, e.g., sale.report_saleorder_document')
    report_id = fields.Many2one('ir.actions.report', string='Report', ondelete='set null', help='Linked Odoo report')

    _sql_constraints = [
        ('branch_idempotency_unique',
         'unique(branch_id, idempotency_key)',
         'This print operation was already submitted for this branch.'),
    ]

    def action_sync_status(self):
        for job in self:
            if not job.gateway_job_id:
                continue
            try:
                branch = job.branch_id
                headers = branch._gateway_headers()
                base = branch._gateway_base()
                resp = requests.get(f"{base}/api/print/jobs", params={'id': job.gateway_job_id}, headers=headers, timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    vals = {
                        'status': data.get('status') or data.get('state') or job.status,
                        'error': data.get('error'),
                        'last_sync_at': fields.Datetime.now(),
                    }
                    # Normalize completed -> success
                    if vals['status'] == 'completed':
                        vals['status'] = 'success'
                    job.write(vals)
                else:
                    _logger.warning("Job %s status sync returned %s", job.gateway_job_id, resp.status_code)
            except Exception as e:
                _logger.warning("Job %s sync failed: %s", job.gateway_job_id, str(e))
        return True

    @api.model
    def cron_sync_pending_jobs(self):
        pending = self.search([('status', 'in', ['queued', 'claimed', 'printing'])])
        if pending:
            pending.action_sync_status()
        return True
