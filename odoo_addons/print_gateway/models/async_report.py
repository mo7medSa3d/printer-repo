# -*- coding: utf-8 -*-
"""Asynchronous report dispatch for Print Gateway."""

import json
import logging
import uuid

from odoo import fields, models, _
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class PrintGatewayAsyncReport(models.Model):
    _inherit = 'ir.actions.report'

    def _enqueue_async_gateway_report(self, docids, data=None):
        self.ensure_one()
        model_name = self.model
        if not model_name:
            raise ValidationError(_('Report model not found'))
        try:
            records = self.env[model_name].browse(docids)
        except KeyError:
            raise ValidationError(_('Model %s not found') % model_name)
        if not records:
            raise ValidationError(_('Cannot print an empty report.'))
        if not records.exists():
            raise ValidationError(_('One or more records to print no longer exist.'))

        mapping_info = self._get_gateway_mapping(record=records[0])
        if not mapping_info or not mapping_info.get('gateway_enabled'):
            return None

        routing_groups = self._validate_recordset_routing_consistency(records, mapping_info)
        routing_group = routing_groups[0]
        branch = routing_group['branch']
        destination = routing_group['destination']
        document_type = routing_group['document_type']

        if not branch or not destination:
            raise ValidationError(_('Print routing is incomplete: branch and destination are required.'))
        if not self._user_has_branch_access(branch):
            raise ValidationError(_('You do not have access to branch %s. Cannot print via this branch.') % branch.name)

        for record in records:
            if 'company_id' in record._fields and record.company_id and record.company_id.id != branch.company_id.id:
                raise ValidationError(_(
                    'Cannot route record from company %s to branch in company %s. Please route to the correct company branch.'
                ) % (record.company_id.name, branch.company_id.name))

        try:
            if data is not None:
                json.dumps(data, separators=(',', ':'), ensure_ascii=False)
        except (TypeError, ValueError) as exc:
            raise ValidationError(_('Report parameters are not JSON serializable.')) from exc

        descriptor = {
            'kind': 'odoo_report_render',
            'report_id': self.id,
            'report_xml_id': self.get_external_id().get(self.id, '') if hasattr(self, 'get_external_id') else self.report_name,
            'model': model_name,
            'res_ids': [int(record.id) for record in records],
            'data': data,
        }
        descriptor_json = json.dumps(descriptor, separators=(',', ':'), ensure_ascii=False)
        if len(descriptor_json.encode('utf-8')) > 512 * 1024:
            raise ValidationError(_('Report parameters are too large to queue safely (maximum 512 KiB).'))

        Job = self.env['print_gateway.print_job']
        job = Job.create({
            'branch_id': branch.id,
            'gateway_job_id': False,
            'destination_id': destination.id,
            'document_type': document_type,
            'status': 'queued',
            'payload': descriptor_json,
            'idempotency_key': uuid.uuid4().hex,
            'odoo_model': model_name,
            'odoo_record_id': records[0].id,
            'report_xml_id': descriptor['report_xml_id'] or False,
            'report_name': self.report_name or False,
            'report_id': self.id,
        })
        _logger.info(
            'Report %s queued as async print operation %s via %s -> %s (%s); PDF rendering and Gateway submission deferred to worker',
            self.report_name, job.idempotency_key[:8], branch.name, destination.name, document_type,
        )
        return job

    def report_action(self, docids, data=None, config=True):
        self.ensure_one()
        normalized_docids = docids
        if isinstance(normalized_docids, int):
            normalized_docids = [normalized_docids]
        elif isinstance(normalized_docids, str):
            try:
                normalized_docids = [int(normalized_docids)]
            except (TypeError, ValueError):
                normalized_docids = docids

        first_record = None
        if normalized_docids and self.model:
            try:
                first_record = self.env[self.model].browse(normalized_docids[:1])
            except (KeyError, TypeError, ValueError):
                first_record = None

        if not self._should_route_via_gateway(record=first_record):
            return super().report_action(docids, data=data, config=config)
        if not normalized_docids:
            return super().report_action(docids, data=data, config=config)

        job = self._enqueue_async_gateway_report(normalized_docids, data=data)
        if not job:
            return super().report_action(docids, data=data, config=config)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('Print Job Queued'),
                'message': _(
                    'Report %s for %d record(s) queued as operation %s (%s -> %s). PDF rendering and Gateway submission will run asynchronously.'
                ) % (
                    self.name, len(normalized_docids), job.idempotency_key[:8], job.branch_id.name,
                    job.destination_id.name if job.destination_id else 'N/A',
                ),
                'type': 'success',
                'sticky': False,
            },
        }


class PrintGatewayAsyncPrintJob(models.Model):
    _inherit = 'print_gateway.print_job'

    def action_submit_pending(self):
        for job in self:
            if job.gateway_job_id:
                continue
            try:
                payload_obj = json.loads(job.payload or '')
            except (TypeError, ValueError) as exc:
                raise ValidationError(_('Persisted print operation %s contains invalid JSON.') % job.id) from exc
            if not isinstance(payload_obj, dict) or payload_obj.get('kind') != 'odoo_report_render':
                super(PrintGatewayAsyncPrintJob, job).action_submit_pending()
                continue

            report_id = payload_obj.get('report_id') or job.report_id.id
            model_name = payload_obj.get('model') or job.odoo_model
            res_ids = payload_obj.get('res_ids') or ([job.odoo_record_id] if job.odoo_record_id else [])
            report_data = payload_obj.get('data')
            if not report_id:
                raise ValidationError(_('Pending report operation %s has no report id.') % job.id)
            if not res_ids:
                raise ValidationError(_('Pending report operation %s has no record ids.') % job.id)

            report = self.env['ir.actions.report'].browse(int(report_id)).exists()
            if not report:
                raise ValidationError(_('Report for pending operation %s no longer exists.') % job.id)
            if model_name and report.model != model_name:
                raise ValidationError(_('Report model changed for pending operation %s; refusing ambiguous rendering.') % job.id)

            try:
                with self.env.cr.savepoint():
                    payload = report._generate_payload_for_report(report, res_ids, report_data)
            except Exception as exc:
                job.write({'error': str(exc)[:4000], 'last_sync_at': fields.Datetime.now()})
                _logger.error('Async PDF rendering failed for print operation %s: %s', job.id, str(exc), exc_info=True)
                raise

            destination = job.destination_id
            if not destination or destination.branch_id != job.branch_id:
                raise ValidationError(_('Pending operation %s has invalid branch/destination routing.') % job.id)
            job.branch_id.create_print_job(
                destination.gateway_destination_id or destination.id,
                job.document_type,
                payload,
                odoo_model=job.odoo_model,
                odoo_record_id=job.odoo_record_id,
                report_xml_id=job.report_xml_id,
                report_name=job.report_name,
                report_id=job.report_id.id if job.report_id else report.id,
                idempotency_key=job.idempotency_key,
            )
        return True
