# -*- coding: utf-8 -*-
"""Odoo 19 compatibility and user-facing error handling for Print Gateway."""

import logging

from odoo import models, _
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class PrintGatewayBranchOdoo19(models.Model):
    _inherit = 'print_gateway.branch'

    _name_company_unique = models.Constraint(
        'UNIQUE(name, company_id)',
        'Branch name must be unique per company',
    )

    def action_sync_from_gateway(self):
        try:
            return super().action_sync_from_gateway()
        except ValidationError as exc:
            self.invalidate_recordset([
                'last_sync_at', 'last_sync_status', 'last_sync_error',
                'last_successful_sync_at',
            ])
            return {
                'type': 'ir.actions.client', 'tag': 'display_notification',
                'params': {
                    'title': _('Gateway sync failed'), 'message': str(exc),
                    'type': 'warning', 'sticky': False,
                },
            }

    def action_sync_to_gateway(self):
        try:
            return super().action_sync_to_gateway()
        except ValidationError as exc:
            self.invalidate_recordset([
                'last_sync_at', 'last_sync_status', 'last_sync_error',
                'last_successful_sync_at',
            ])
            return {
                'type': 'ir.actions.client', 'tag': 'display_notification',
                'params': {
                    'title': _('Gateway sync partially failed'), 'message': str(exc),
                    'type': 'warning', 'sticky': False,
                },
            }

    def cron_retry_pending_print_jobs(self):
        Job = self.env['print_gateway.print_job']
        pending = Job.search([
            ('gateway_job_id', '=', False), ('status', '=', 'queued'),
        ], order='id asc', limit=100)
        retried = 0
        for job in pending:
            try:
                if job.action_submit_pending():
                    retried += 1
            except Exception as exc:
                _logger.warning(
                    "Pending Gateway print retry failed for operation %s: %s",
                    job.id, str(exc),
                )
        return retried


class PrintGatewayAsyncPrintJobOdoo19(models.Model):
    _inherit = 'print_gateway.print_job'

    _branch_idempotency_unique = models.Constraint(
        'UNIQUE(branch_id, idempotency_key)',
        'This print operation was already submitted for this branch.',
    )

    def action_submit_pending(self):
        try:
            return super().action_submit_pending()
        except Exception as exc:
            for job in self:
                job.write({'error': str(exc)[:4000]})
            return False


class PrintGatewayReportRoutingContractOdoo19(models.Model):
    _inherit = 'ir.actions.report'

    def _determine_destination(self, branch, record=None, mapping_info=None):
        try:
            return super()._determine_destination(
                branch, record=record, mapping_info=mapping_info
            )
        except ValidationError:
            explicit_destination = bool(mapping_info and mapping_info.get('destination_id'))
            if record and 'print_gateway_destination_id' in record._fields:
                try:
                    explicit_destination = explicit_destination or bool(record.print_gateway_destination_id)
                except Exception:
                    pass
            if (
                branch and not explicit_destination and
                not branch.destination_ids.filtered(lambda d: d.enabled)
            ):
                raise ValidationError(_(
                    'No print destination is configured for branch %s: '
                    'there are no enabled destinations. Configure an explicit '
                    'destination in the report mapping or record.'
                ) % branch.name)
            raise

    def _validate_recordset_routing_consistency(self, records, mapping_info):
        company_ids = {
            record.company_id.id
            for record in records
            if getattr(record, 'company_id', False)
        }
        if len(company_ids) > 1 and not mapping_info:
            raise ValidationError(_(
                'This report contains records with different print routing '
                '(branch/destination/document type). Please print records '
                'separately to ensure correct routing. Groups found: %d'
            ) % len(company_ids))
        return super()._validate_recordset_routing_consistency(records, mapping_info)
