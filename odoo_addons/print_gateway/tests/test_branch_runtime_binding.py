from unittest.mock import patch

from odoo import api
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class _Response:
    def __init__(self, body, status_code=200):
        self._body = body
        self.status_code = status_code

    def json(self):
        return self._body


class TestBranchRuntimeBinding(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.branch = self.env["res.company"].create({
            "name": "Gateway Branch A",
            "parent_id": self.company.id,
        })
        self.other_company = self.env["res.company"].create({"name": "Gateway Other Company"})
        self.other_branch = self.env["res.company"].create({
            "name": "Gateway Branch B",
            "parent_id": self.other_company.id,
        })
        self.env = self.env(context=dict(self.env.context, allowed_company_ids=[
            self.company.id, self.branch.id, self.other_company.id, self.other_branch.id,
        ]))

        config_model = self.env["print_gateway.gateway_config"]
        with patch.object(
            type(config_model), "_validate_gateway_host", return_value=None
        ):
            self.config = config_model.search([("company_id", "=", self.company.id)], limit=1)
            values = {
                "gateway_url": "https://gateway.example.com",
                "gateway_api_key": "odoo_test_key",
                "enabled": True,
            }
            if self.config:
                self.config.write(values)
            else:
                self.config = config_model.create({"company_id": self.company.id, **values})

        self.agents = [
            {"id": "agent-A", "name": "Agent A", "status": "online", "lifecycle": "active"},
            {"id": "agent-B", "name": "Agent B", "status": "online", "lifecycle": "active"},
            {"id": "agent-retired", "name": "Retired", "status": "offline", "lifecycle": "retired"},
        ]
        self.printers = [
            {"id": "printer-A", "name": "Printer A", "status": "online", "lifecycle": "active", "agent": {"id": "agent-A", "name": "Agent A"}},
            {"id": "printer-B", "name": "Printer B", "status": "online", "lifecycle": "active", "agent": {"id": "agent-B", "name": "Agent B"}},
        ]

    def _responses(self):
        return [_Response({"agents": self.agents}), _Response({"printers": self.printers})]

    def _report(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        self.assertTrue(report)
        return report

    def test_branch_must_belong_to_selected_company(self):
        binding = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": self.other_branch.id,
            "runtime_agent_id": "agent-A",
            "printer_id": "printer-A",
        })
        with self.assertRaises(ValidationError):
            binding._check_runtime_scope()

    def test_unauthorized_company_is_rejected_even_when_record_is_selectable(self):
        restricted_env = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id]))
        binding = restricted_env["print_gateway.binding"].new({
            "company_id": self.other_company.id,
            "branch_id": self.other_branch.id,
            "runtime_agent_id": "agent-B",
            "printer_id": "printer-B",
        })
        with self.assertRaises(ValidationError):
            binding._check_runtime_scope()

    def test_destination_from_parent_company_is_rejected_for_branch_binding(self):
        picking_type = self.env["stock.picking.type"].search([
            ("company_id", "=", self.company.id),
        ], limit=1)
        report = self.env["ir.actions.report"].search([
            ("model", "=", "stock.picking"),
        ], limit=1)
        self.assertTrue(picking_type)
        self.assertTrue(report)
        with self.assertRaises(ValidationError):
            self.env["print_gateway.binding"].create({
                "company_id": self.company.id,
                "branch_id": self.branch.id,
                "destination_type": "picking_type",
                "destination_picking_type_id": picking_type.id,
                "report_id": report.id,
                "runtime_agent_id": "agent-A",
                "printer_id": "printer-A",
            })

    def test_retired_or_unknown_agent_is_rejected(self):
        report = self._report()
        with patch.object(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._responses(),
        ), patch.object(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            for agent_id in ("agent-retired", "agent-missing"):
                with self.assertRaises(ValidationError):
                    self.env["print_gateway.binding"].create({
                        "company_id": self.company.id,
                        "branch_id": self.branch.id,
                        "destination_type": "report",
                        "destination_report_id": report.id,
                        "report_id": report.id,
                        "runtime_agent_id": agent_id,
                        "printer_id": "printer-A",
                    })

    def test_printer_from_another_agent_is_rejected(self):
        binding = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-A",
            "printer_id": "printer-B",
        })
        with patch.object(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._responses(),
        ), patch.object(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            with self.assertRaises(ValidationError):
                binding._validate_runtime_target()

    def test_full_branch_binding_persists_and_creates_branch_agent_assignment(self):
        report = self._report()
        with patch.object(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._responses(),
        ), patch.object(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            binding = self.env["print_gateway.binding"].create({
                "company_id": self.company.id,
                "branch_id": self.branch.id,
                "destination_type": "report",
                "destination_report_id": report.id,
                "report_id": report.id,
                "runtime_agent_id": "agent-A",
                "printer_id": "printer-A",
                "enabled": True,
                "priority": 10,
            })
        self.assertTrue(binding)
        self.assertEqual(binding.company_id, self.company)
        self.assertEqual(binding.branch_id, self.branch)
        self.assertEqual(binding.runtime_agent_id, "agent-A")
        self.assertEqual(binding.printer_id, "printer-A")
        assignment = self.env["print_gateway.runtime_agent_assignment"].search([
            ("company_id", "=", self.company.id), ("branch_id", "=", self.branch.id),
        ], limit=1)
        self.assertTrue(assignment)
        self.assertEqual(assignment.runtime_agent_id, "agent-A")

    def test_same_branch_agent_printer_and_destination_can_be_reopened_from_persisted_row(self):
        report = self._report()
        with patch.object(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._responses(),
        ), patch.object(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            binding = self.env["print_gateway.binding"].create({
                "company_id": self.company.id, "branch_id": self.branch.id,
                "destination_type": "report", "destination_report_id": report.id,
                "report_id": report.id, "runtime_agent_id": "agent-A",
                "printer_id": "printer-A", "enabled": True, "priority": 20,
            })
        reopened = self.env["print_gateway.binding"].browse(binding.id)
        self.assertEqual(reopened.company_id.id, self.company.id)
        self.assertEqual(reopened.branch_id.id, self.branch.id)
        self.assertEqual(reopened.runtime_agent_id, "agent-A")
        self.assertEqual(reopened.printer_id, "printer-A")
        self.assertEqual(reopened.destination_ref.id, report.id)

    def test_find_for_uses_branch_binding_for_active_branch(self):
        report = self._report()
        with patch.object(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._responses(),
        ), patch.object(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            binding = self.env["print_gateway.binding"].create({
                "company_id": self.company.id, "branch_id": self.branch.id,
                "destination_type": "report", "destination_report_id": report.id,
                "report_id": report.id, "runtime_agent_id": "agent-A",
                "printer_id": "printer-A", "enabled": True, "priority": 30,
            })
        found = self.env["print_gateway.binding"].find_for(
            self.company, "order", report=report, branch=self.branch,
        )
        self.assertEqual(found.id, binding.id)

    def test_onchange_agent_clears_printer(self):
        binding = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-A",
            "printer_id": "printer-A",
        })
        binding._onchange_runtime_agent_id()
        self.assertFalse(binding.printer_id)

    def test_onchange_branch_clears_runtime_and_destination(self):
        binding = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-A",
            "printer_id": "printer-A",
        })
        binding._onchange_branch_id()
        self.assertFalse(binding.runtime_agent_id)
        self.assertFalse(binding.printer_id)
