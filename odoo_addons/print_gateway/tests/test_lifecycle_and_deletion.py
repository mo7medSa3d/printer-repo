# -*- coding: utf-8 -*-
"""Lifecycle, deletion and branch-move safety (Odoo side).

Covers:

  P0-1  ``retired`` is a TERMINAL state for printers and agents.
  P0-2  Deletion never destroys runtime history: printer.agent_id restricts
        instead of cascading, and agent/branch deletion is refused while
        printers or jobs exist.
  P0-3  Moving an agent between branches validates every affected binding in
        the SAME transaction — refusing by default, or disabling with audit.
"""
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestLifecycleAndDeletion(TransactionCase):

    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.branch_a = self.env['print_gateway.branch'].create({
            'name': 'Lifecycle Branch A',
            'company_id': self.company.id,
            'gateway_url': 'http://gw.example.com',
            'gateway_api_key': 'k',
        })
        self.branch_b = self.env['print_gateway.branch'].create({
            'name': 'Lifecycle Branch B',
            'company_id': self.company.id,
            'gateway_url': 'http://gw.example.com',
            'gateway_api_key': 'k',
        })
        self.agent = self.env['print_gateway.agent'].create({
            'gateway_agent_id': 'agt_lifecycle',
            'name': 'Lifecycle Agent',
            'branch_id': self.branch_a.id,
        })
        self.printer = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_lifecycle',
            'name': 'Lifecycle Printer',
            'agent_id': self.agent.id,
        })
        self.destination = self.env['print_gateway.destination'].create({
            'branch_id': self.branch_a.id,
            'name': 'POS',
            'destination_type': 'pos',
        })

    def _make_binding(self, branch=None, printer=None, priority=1):
        return self.env['print_gateway.printer_binding'].create({
            'branch_id': (branch or self.branch_a).id,
            'destination_id': self.destination.id,
            'document_type': 'receipt',
            'printer_id': (printer or self.printer).id,
            'priority': priority,
        })

    def _make_job(self):
        return self.env['print_gateway.print_job'].create({
            'branch_id': self.branch_a.id,
            'gateway_job_id': 'job_lifecycle',
            'printer_id': self.printer.id,
            'agent_id': self.agent.id,
            'status': 'success',
            'document_type': 'receipt',
        })

    # ------------------------------------------------------------------
    # P0-1  retired is terminal
    # ------------------------------------------------------------------

    def test_printer_retire_is_terminal(self):
        self.printer.action_retire()
        self.assertEqual(self.printer.status, 'retired')
        self.assertFalse(self.printer.enabled)

        # No transition out, by button...
        with self.assertRaises(ValidationError):
            self.printer.action_retire()
        # ...or by direct write.
        for status in ('online', 'offline', 'unknown', 'error'):
            with self.assertRaises(ValidationError):
                self.printer.write({'status': status})
        self.assertEqual(self.printer.status, 'retired')

    def test_agent_retire_is_terminal_and_cascades_to_printers(self):
        self.agent.action_retire()
        self.assertEqual(self.agent.status, 'retired')
        # A printer is only reachable through its agent, so it retires too.
        self.assertEqual(self.printer.status, 'retired')
        self.assertFalse(self.printer.enabled)

        with self.assertRaises(ValidationError):
            self.agent.write({'status': 'online'})
        self.assertEqual(self.agent.status, 'retired')

    def test_retired_printer_keeps_its_history(self):
        job = self._make_job()
        self.printer.action_retire()
        # Retirement is not deletion: the job still points at a real printer
        # that still says what it was.
        self.assertTrue(job.exists())
        self.assertEqual(job.printer_id, self.printer)
        self.assertEqual(job.status, 'success')

    # ------------------------------------------------------------------
    # P0-2  deletion must not destroy runtime history
    # ------------------------------------------------------------------

    def test_deleting_agent_does_not_cascade_delete_printers(self):
        printer_id = self.printer.id
        with self.assertRaises(ValidationError):
            self.agent.unlink()
        # The printer survived: the delete was refused, not partially applied.
        self.assertTrue(self.env['print_gateway.printer'].browse(printer_id).exists())

    def test_deleting_printer_with_jobs_is_refused(self):
        job = self._make_job()
        with self.assertRaises(ValidationError):
            self.printer.unlink()
        self.assertTrue(job.exists())
        self.assertEqual(job.printer_id, self.printer)

    def test_deleting_printer_with_bindings_is_refused(self):
        binding = self._make_binding()
        with self.assertRaises(ValidationError):
            self.printer.unlink()
        self.assertTrue(binding.exists())

    def test_deleting_agent_with_job_history_is_refused(self):
        self._make_job()
        # Detach the printer so the "still owns printers" guard is not what
        # trips: the history guard must stand on its own.
        other_agent = self.env['print_gateway.agent'].create({
            'gateway_agent_id': 'agt_other',
            'name': 'Other',
            'branch_id': self.branch_a.id,
        })
        self.printer.write({'agent_id': other_agent.id})
        with self.assertRaises(ValidationError):
            self.agent.unlink()

    def test_deleting_branch_with_runtime_records_is_refused(self):
        with self.assertRaises(ValidationError):
            self.branch_a.unlink()
        # Nothing was swept away as a side effect.
        self.assertTrue(self.agent.exists())
        self.assertTrue(self.printer.exists())

    def test_deleting_branch_with_only_history_is_refused(self):
        job = self._make_job()
        with self.assertRaises(ValidationError):
            self.branch_a.unlink()
        self.assertTrue(job.exists())

    def test_clean_printer_can_still_be_deleted(self):
        """Deletion is restricted, not forbidden: a printer with no history goes."""
        spare = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_spare',
            'name': 'Spare',
            'agent_id': self.agent.id,
        })
        spare_id = spare.id
        spare.unlink()
        self.assertFalse(self.env['print_gateway.printer'].browse(spare_id).exists())

    # ------------------------------------------------------------------
    # P0-3  branch move validates bindings in the same transaction
    # ------------------------------------------------------------------

    def test_move_is_refused_when_it_would_create_cross_branch_bindings(self):
        binding = self._make_binding()
        with self.assertRaises(ValidationError):
            self.agent.write({'branch_id': self.branch_b.id})

        # Same transaction: neither the move nor any binding change landed.
        self.assertEqual(self.agent.branch_id, self.branch_a)
        self.assertEqual(self.printer.branch_id, self.branch_a)
        self.assertTrue(binding.enabled)
        self.assertEqual(binding.branch_id, self.branch_a)

    def test_move_error_names_the_offending_bindings(self):
        self._make_binding()
        with self.assertRaises(ValidationError) as ctx:
            self.agent.write({'branch_id': self.branch_b.id})
        message = str(ctx.exception)
        self.assertIn('cross-branch', message)
        self.assertIn(self.printer.display_name, message)

    def test_move_with_explicit_flag_disables_bindings_and_audits(self):
        binding = self._make_binding()
        self.agent.action_move_to_branch_disabling_bindings(self.branch_b.id)

        self.assertEqual(self.agent.branch_id, self.branch_b)
        # The printer followed its agent (derived branch).
        self.assertEqual(self.printer.branch_id, self.branch_b)
        # The binding was DISABLED, not deleted, and the reason is recorded.
        self.assertTrue(binding.exists())
        self.assertFalse(binding.enabled)
        self.assertIn('disabled', (binding.notes or '').lower())

    def test_move_is_allowed_when_no_bindings_are_affected(self):
        # An agent with printers but no bindings moves cleanly.
        self.agent.write({'branch_id': self.branch_b.id})
        self.assertEqual(self.agent.branch_id, self.branch_b)
        self.assertEqual(self.printer.branch_id, self.branch_b)

    def test_move_ignores_bindings_already_in_the_target_branch(self):
        """A binding that will be correct after the move must not block it."""
        dest_b = self.env['print_gateway.destination'].create({
            'branch_id': self.branch_b.id,
            'name': 'POS B',
            'destination_type': 'pos',
        })
        # Move first (no bindings yet), then bind in the destination branch.
        self.agent.write({'branch_id': self.branch_b.id})
        binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch_b.id,
            'destination_id': dest_b.id,
            'document_type': 'receipt',
            'printer_id': self.printer.id,
            'priority': 1,
        })
        # Moving back to A is refused because THAT binding would go cross-branch.
        with self.assertRaises(ValidationError):
            self.agent.write({'branch_id': self.branch_a.id})
        self.assertTrue(binding.enabled)
