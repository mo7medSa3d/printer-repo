# -*- coding: utf-8 -*-
"""Odoo 19 compatibility and durable operation boundaries.

This extension keeps the existing domain models intact while moving SQL
constraints to the Odoo 19 ``models.Constraint`` API and isolating operations
whose durable result must survive a UI-facing exception.
"""

from odoo import api, models, _
from odoo.exceptions import ValidationError


class PrintGatewayBranchOdoo19(models.Model):
    _inherit = 'print_gateway.branch'
    _sql_constraints = []

    _name_company_unique = models.Constraint(
        'UNIQUE(name, company_id)',
        'Branch name must be unique per company',
    )


class PrintGatewayDestinationOdoo19(models.Model):
    _inherit = 'print_gateway.destination'
    _sql_constraints = []

    _name_branch_unique = models.Constraint(
        'UNIQUE(name, branch_id)',
        'Destination name must be unique per branch',
    )


class PrintGatewayDocumentTypeOdoo19(models.Model):
    _inherit = 'print_gateway.document_type'
    _sql_constraints = []

    _name_branch_unique = models.Constraint(
        'UNIQUE(name, branch_id)',
        'Document type must be unique per branch',
    )


class PrintGatewayAgentOdoo19(models.Model):
    _inherit = 'print_gateway.agent'
    _sql_constraints = []

    _gateway_agent_id_unique = models.Constraint(
        'UNIQUE(gateway_agent_id)',
        'Agent ID must be globally unique',
    )


class PrintGatewayPrinterOdoo19(models.Model):
    _inherit = 'print_gateway.printer'
    _sql_constraints = []

    _gateway_printer_id_unique = models.Constraint(
        'UNIQUE(gateway_printer_id)',
        'Printer ID must be globally unique',
    )


class PrintGatewayPrinterBindingOdoo19(models.Model):
    _inherit = 'print_gateway.printer_binding'
    _sql_constraints = []

    _priority_branch_dest_doctype_unique = models.Constraint(
        'UNIQUE(branch_id, destination_id, document_type, priority)',
        'Priority must be unique per branch/destination/document_type',
    )


class PrintGatewayPrintJobOdoo19(models.Model):
    _inherit = 'print_gateway.print_job'
    _sql_constraints = []

    _branch_idempotency_unique = models.Constraint(
        'UNIQUE(branch_id, idempotency_key)',
        'This print operation was already submitted for this branch.',
    )


class PrintGatewayReportMappingOdoo19(models.Model):
    _inherit = 'print_gateway.report_mapping'
    _sql_constraints = []

    _priority_unique = models.Constraint(
        'UNIQUE(report_id, priority)',
        'Priority must be unique per exact report.',
    )


class PrintGatewayDurableOperations(models.AbstractModel):
    """Helpers for operations whose audit state must survive UI exceptions."""

    _name = 'print_gateway.durable_operations'
    _description = 'Print Gateway Durable Operations Helpers'

    @staticmethod
    def _isolated_env(record):
        registry = record.env.registry
        cr = registry.cursor()
        env = api.Environment(cr, record.env.uid, dict(record.env.context))
        return cr, env


class PrintGatewayBranchDurability(models.Model):
    _inherit = 'print_gateway.branch'

    def _run_branch_operation_isolated(self, branch_id, method_name):
        """Run a branch sync in an isolated cursor and commit its result.

        The original methods intentionally raise ValidationError after recording
        failures. Running them in the HTTP request cursor would roll back the
        status together with unrelated request changes. This wrapper keeps the
        operation in a dedicated cursor so success/partial/failure state and
        pulled runtime records are durable per branch.
        """
        registry = self.env.registry
        with registry.cursor() as cr:
            env = api.Environment(cr, self.env.uid, dict(self.env.context))
            branch = env['print_gateway.branch'].browse(branch_id).exists()
            if not branch:
                return None
            try:
                getattr(super(PrintGatewayBranchDurability, branch), method_name)()
            except Exception as exc:
                # The parent intentionally persists its outcome before raising.
                # ValidationError is not a PostgreSQL abort, so the transaction
                # can still be committed here without touching the caller's
                # transaction.
                cr.commit()
                return exc
            else:
                cr.commit()
                return None

    def _invalidate_sync_cache(self):
        self.invalidate_recordset([
            'last_sync_at',
            'last_sync_status',
            'last_sync_error',
            'last_successful_sync_at',
        ])

    def action_sync_from_gateway(self):
        errors = []
        for branch_id in self.ids:
            exc = self._run_branch_operation_isolated(branch_id, 'action_sync_from_gateway')
            if exc:
                errors.append(str(exc))
        self._invalidate_sync_cache()
        if errors:
            raise ValidationError(_('Gateway pull sync did not fully succeed:\n%s') % '\n'.join(
                '- %s' % error for error in errors
            ))
        return True

    def action_sync_to_gateway(self):
        errors = []
        for branch_id in self.ids:
            exc = self._run_branch_operation_isolated(branch_id, 'action_sync_to_gateway')
            if exc:
                errors.append(str(exc))
        self._invalidate_sync_cache()
        if errors:
            raise ValidationError(_('Sync partially failed (%s of %s branches):\n%s') % (
                len(errors),
                len(self),
                '\n'.join('- %s' % error for error in errors),
            ))
        return True


class PrintGatewayAsyncPrintJobDurability(models.Model):
    _inherit = 'print_gateway.print_job'

    def action_submit_pending(self):
        """Run each pending operation in a dedicated cursor.

        The existing async report implementation records render failures and
        raises so cron/UI callers see the failure. Here the entire operation is
        isolated so that the recorded error remains durable after the exception.
        """
        errors = []
        for job_id in self.ids:
            registry = self.env.registry
            with registry.cursor() as cr:
                env = api.Environment(cr, self.env.uid, dict(self.env.context))
                job = env['print_gateway.print_job'].browse(job_id).exists()
                if not job:
                    continue
                try:
                    getattr(super(PrintGatewayAsyncPrintJobDurability, job), 'action_submit_pending')()
                except Exception as exc:
                    # Persist the failure even if the parent code did not reach
                    # its own error write (e.g. malformed descriptor/routing).
                    job.write({
                        'error': str(exc)[:4000],
                    })
                    cr.commit()
                    errors.append((job_id, str(exc)))
                else:
                    cr.commit()

        self.invalidate_recordset([
            'gateway_job_id',
            'status',
            'error',
            'last_sync_at',
            'payload',
        ])
        if errors:
            job_id, message = errors[0]
            raise ValidationError(_('Pending print operation %s failed: %s') % (job_id, message))
        return True


class PrintGatewayReportRoutingContract(models.Model):
    _inherit = 'ir.actions.report'

    def _determine_destination(self, branch, record=None, mapping_info=None):
        try:
            return super()._determine_destination(branch, record=record, mapping_info=mapping_info)
        except ValidationError:
            if branch and not branch.destination_ids.filtered(lambda destination: destination.enabled):
                raise ValidationError(_(
                    'Unable to determine a print destination for branch %s: '
                    'there are no enabled destinations. Configure an explicit destination '
                    'in the report mapping or record.'
                ) % branch.name)
            raise

    def _validate_recordset_routing_consistency(self, records, mapping_info):
        """Reject cross-company multi-record routing before destination lookup."""
        company_ids = set()
        for record in records:
            company = getattr(record, 'company_id', False)
            if company:
                company_ids.add(company.id)
        if len(company_ids) > 1:
            raise ValidationError(_(
                'This report contains records with different print routing '
                '(branch/destination/document type). Please print records separately '
                'to ensure correct routing. Groups found: %d'
            ) % len(company_ids))
        return super()._validate_recordset_routing_consistency(records, mapping_info)
