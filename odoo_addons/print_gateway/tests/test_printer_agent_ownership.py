# -*- coding: utf-8 -*-
"""Regression tests for the Branch -> Agent -> Printer ownership model.

These cover the Odoo side of the architectural migration:

  * an agent has a branch;
  * a printer derives its branch through its agent and has no independent one;
  * a printer cannot be created without an agent;
  * reassigning an agent moves every one of its printers;
  * bindings may not cross branches, validated through printer -> agent;
  * Gateway -> Odoo sync handles new / reassigned / stale / unknown-agent
    printers and never duplicates a record across branches.
"""
from unittest.mock import patch, MagicMock

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class TestPrinterAgentOwnership(TransactionCase):

    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.branch_a = self.env['print_gateway.branch'].create({
            'name': 'Branch A',
            'company_id': self.company.id,
            'gateway_url': 'http://gw.example.com',
            'gateway_api_key': 'k',
        })
        self.branch_b = self.env['print_gateway.branch'].create({
            'name': 'Branch B',
            'company_id': self.company.id,
            'gateway_url': 'http://gw.example.com',
            'gateway_api_key': 'k',
        })
        self.agent_a = self.env['print_gateway.agent'].create({
            'gateway_agent_id': 'agt_a',
            'name': 'Agent A',
            'branch_id': self.branch_a.id,
        })
        self.agent_b = self.env['print_gateway.agent'].create({
            'gateway_agent_id': 'agt_b',
            'name': 'Agent B',
            'branch_id': self.branch_b.id,
        })
        self.printer_a = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_a',
            'name': 'Printer A',
            'agent_id': self.agent_a.id,
        })

    # ------------------------------------------------------------ ownership
    def test_agent_has_branch(self):
        self.assertEqual(self.agent_a.branch_id, self.branch_a)

    def test_printer_branch_is_derived_from_agent(self):
        self.assertEqual(self.printer_a.branch_id, self.branch_a)

    def test_printer_branch_is_readonly(self):
        field = self.env['print_gateway.printer']._fields['branch_id']
        self.assertTrue(field.related, "printer.branch_id must be a related field on agent_id.branch_id")
        self.assertEqual(field.related, ('agent_id', 'branch_id'))
        self.assertTrue(field.readonly, "printer.branch_id must not be independently writable")

    def test_printer_requires_an_agent(self):
        with self.assertRaises(Exception):
            self.env['print_gateway.printer'].create({
                'gateway_printer_id': 'printer_orphan',
                'name': 'Orphan',
            })

    def test_printer_registered_without_branch_inherits_agent_branch(self):
        printer = self.env['print_gateway.printer'].create({
            'gateway_printer_id': 'printer_new',
            'name': 'New',
            'agent_id': self.agent_b.id,
        })
        self.assertEqual(printer.branch_id, self.branch_b)

    def test_agent_reassignment_moves_its_printers(self):
        self.agent_a.write({'branch_id': self.branch_b.id})
        self.printer_a.invalidate_recordset()
        self.assertEqual(
            self.printer_a.branch_id, self.branch_b,
            "moving the agent must move every printer it owns — there is no second place to update")

    def test_printer_reassignment_to_other_agent_changes_branch(self):
        self.printer_a.write({'agent_id': self.agent_b.id})
        self.assertEqual(self.printer_a.branch_id, self.branch_b)

    def test_duplicate_gateway_printer_id_is_rejected(self):
        with self.assertRaises(Exception):
            with self.env.cr.savepoint():
                self.env['print_gateway.printer'].create({
                    'gateway_printer_id': 'printer_a',
                    'name': 'Duplicate in another branch',
                    'agent_id': self.agent_b.id,
                })

    def test_duplicate_gateway_agent_id_is_rejected(self):
        with self.assertRaises(Exception):
            with self.env.cr.savepoint():
                self.env['print_gateway.agent'].create({
                    'gateway_agent_id': 'agt_a',
                    'name': 'Duplicate agent',
                    'branch_id': self.branch_b.id,
                })

    def test_agent_printer_ids_is_a_real_one2many(self):
        self.assertIn(self.printer_a, self.agent_a.printer_ids)
        self.assertEqual(self.agent_a.printer_count, 1)
        self.assertNotIn(self.printer_a, self.agent_b.printer_ids)

    # -------------------------------------------------------------- binding
    def test_cross_branch_binding_is_refused(self):
        dest_b = self.env['print_gateway.destination'].create({
            'name': 'POS B', 'branch_id': self.branch_b.id,
        })
        with self.assertRaises(ValidationError):
            self.env['print_gateway.printer_binding'].create({
                'branch_id': self.branch_b.id,
                'destination_id': dest_b.id,
                'printer_id': self.printer_a.id,  # printer's agent is in Branch A
            })

    def test_same_branch_binding_is_allowed(self):
        dest_a = self.env['print_gateway.destination'].create({
            'name': 'POS A', 'branch_id': self.branch_a.id,
        })
        binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch_a.id,
            'destination_id': dest_a.id,
            'printer_id': self.printer_a.id,
        })
        self.assertEqual(binding.printer_agent_id, self.agent_a)

    def test_binding_breaks_when_agent_moves_away(self):
        """Moving the agent invalidates bindings that were valid before."""
        dest_a = self.env['print_gateway.destination'].create({
            'name': 'POS A2', 'branch_id': self.branch_a.id,
        })
        binding = self.env['print_gateway.printer_binding'].create({
            'branch_id': self.branch_a.id,
            'destination_id': dest_a.id,
            'printer_id': self.printer_a.id,
        })
        self.agent_a.write({'branch_id': self.branch_b.id})
        with self.assertRaises(ValidationError):
            binding._check_branch_consistency()

    # ----------------------------------------------------------------- sync
    def _mock_sync(self, agents_payload, printers_payload):
        def fake_get(url, params=None, headers=None, timeout=None):
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = agents_payload if '/api/odoo/agents' in url else printers_payload
            return resp
        return patch('odoo.addons.print_gateway.models.branch.requests.get', side_effect=fake_get)

    def test_sync_creates_printer_under_its_agent(self):
        with self._mock_sync(
            [{'id': 'agt_new', 'name': 'New Agent', 'status': 'online'}],
            [{'id': 'printer_new', 'name': 'New Printer', 'agentId': 'agt_new', 'status': 'online', 'enabled': True}],
        ):
            self.branch_a.action_sync_from_gateway()
        printer = self.env['print_gateway.printer'].search([('gateway_printer_id', '=', 'printer_new')])
        self.assertEqual(len(printer), 1)
        self.assertEqual(printer.agent_id.gateway_agent_id, 'agt_new')
        self.assertEqual(printer.branch_id, self.branch_a)

    def test_sync_skips_printer_with_unknown_agent(self):
        with self._mock_sync(
            [],
            [{'id': 'printer_ghost', 'name': 'Ghost', 'agentId': 'agt_missing'}],
        ):
            self.branch_a.action_sync_from_gateway()
        self.assertFalse(self.env['print_gateway.printer'].search([('gateway_printer_id', '=', 'printer_ghost')]))

    def test_sync_moves_a_reassigned_agent_instead_of_duplicating_it(self):
        """agt_a currently mirrors into Branch A; the Gateway now reports it in Branch B."""
        with self._mock_sync(
            [{'id': 'agt_a', 'name': 'Agent A', 'status': 'online'}],
            [{'id': 'printer_a', 'name': 'Printer A', 'agentId': 'agt_a', 'status': 'online', 'enabled': True}],
        ):
            self.branch_b.action_sync_from_gateway()
        agents = self.env['print_gateway.agent'].search([('gateway_agent_id', '=', 'agt_a')])
        self.assertEqual(len(agents), 1, "a reassigned agent must be moved, never duplicated across branches")
        self.assertEqual(agents.branch_id, self.branch_b)
        self.printer_a.invalidate_recordset()
        self.assertEqual(self.printer_a.branch_id, self.branch_b, "the printer follows its agent")

    def test_sync_marks_stale_printers_offline_without_deleting_them(self):
        with self._mock_sync(
            [{'id': 'agt_a', 'name': 'Agent A', 'status': 'online'}],
            [],
        ):
            self.branch_a.action_sync_from_gateway()
        self.printer_a.invalidate_recordset()
        self.assertTrue(self.printer_a.exists(), "stale printers are never deleted (bindings/jobs reference them)")
        self.assertEqual(self.printer_a.status, 'offline')
        self.assertFalse(self.printer_a.enabled)
