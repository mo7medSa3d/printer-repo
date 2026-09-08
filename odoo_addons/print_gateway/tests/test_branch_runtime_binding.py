from unittest.mock import patch

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase


class Response:
    def __init__(self, body, status_code=200):
        self.body = body
        self.status_code = status_code

    def json(self):
        return self.body


class TestBranchRuntimeBinding(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.branch = self.env["res.company"].create({"name": "Gateway Branch", "parent_id": self.company.id})
        self.other_company = self.env["res.company"].create({"name": "Other Company"})
        self.other_branch = self.env["res.company"].create({"name": "Other Branch", "parent_id": self.other_company.id})
        self.env = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id, self.branch.id, self.other_company.id, self.other_branch.id]))
        self.agents = [
            {"id": "agent-a", "name": "Agent A", "status": "online", "lifecycle": "active"},
            {"id": "agent-b", "name": "Agent B", "status": "online", "lifecycle": "active"},
            {"id": "agent-old", "name": "Retired", "status": "offline", "lifecycle": "retired"},
        ]
        self.printers = [
            {"id": "printer-a", "name": "Printer A", "status": "online", "lifecycle": "active", "agent": {"id": "agent-a", "name": "Agent A"}},
            {"id": "printer-b", "name": "Printer B", "status": "online", "lifecycle": "active", "agent": {"id": "agent-b", "name": "Agent B"}},
        ]
        with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            config_model = self.env["print_gateway.gateway_config"]
            self.config = config_model.search([("company_id", "=", self.company.id)], limit=1)
            vals = {"gateway_url": "https://gateway.example.com", "gateway_api_key": "test-key", "enabled": True}
            self.config = self.config or config_model.create({"company_id": self.company.id, **vals})
            if self.config:
                self.config.write(vals)

    def _gets(self):
        return [Response({"agents": self.agents}), Response({"printers": self.printers})]

    def _report(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        self.assertTrue(report)
        return report

    def _values(self, **extra):
        report = self._report()
        vals = {
            "company_id": self.company.id, "branch_id": self.branch.id,
            "destination_type": "report", "destination_report_id": report.id, "report_id": report.id,
            "runtime_agent_id": "agent-a", "printer_id": "printer-a", "enabled": True, "priority": 10,
        }
        vals.update(extra)
        return vals

    def test_non_root_company_is_rejected(self):
        record = self.env["print_gateway.binding"].new({
            "company_id": self.branch.id,
            "branch_id": False,
            "runtime_agent_id": "agent-a",
            "printer_id": "printer-a",
        })
        with self.assertRaises(ValidationError):
            record._check_company_hierarchy()

    def test_branch_from_another_company_is_rejected(self):
        record = self.env["print_gateway.binding"].new({"company_id": self.company.id, "branch_id": self.other_branch.id, "runtime_agent_id": "agent-a", "printer_id": "printer-a"})
        with self.assertRaises(ValidationError):
            record._check_company_hierarchy()

    def test_unauthorized_company_is_rejected(self):
        restricted = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id]))
        record = restricted["print_gateway.binding"].new({"company_id": self.other_company.id, "branch_id": self.other_branch.id, "runtime_agent_id": "agent-b", "printer_id": "printer-b"})
        with self.assertRaises(ValidationError):
            record._check_runtime_scope()

    def test_retired_agent_is_rejected(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", return_value=Response({"agents": self.agents})), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            with self.assertRaises(ValidationError):
                self.env["print_gateway.binding"].create(self._values(runtime_agent_id="agent-old"))

    def test_printer_from_another_agent_is_rejected(self):
        record = self.env["print_gateway.binding"].new({"company_id": self.company.id, "branch_id": self.branch.id, "runtime_agent_id": "agent-a", "printer_id": "printer-b"})
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            with self.assertRaises(ValidationError):
                record._validate_runtime_target()

    def test_parent_company_destination_is_rejected_for_branch(self):
        picking_type = self.env["stock.picking.type"].search([("company_id", "=", self.company.id)], limit=1)
        report = self.env["ir.actions.report"].search([("model", "=", "stock.picking")], limit=1)
        self.assertTrue(picking_type and report)
        with self.assertRaises(ValidationError):
            self.env["print_gateway.binding"].create(self._values(destination_type="picking_type", destination_picking_type_id=picking_type.id, report_id=report.id))

    def test_valid_full_binding_persists_and_creates_branch_assignment(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values())
        self.assertEqual((binding.company_id.id, binding.branch_id.id, binding.runtime_agent_id, binding.printer_id), (self.company.id, self.branch.id, "agent-a", "printer-a"))
        assignment = self.env["print_gateway.runtime_agent_assignment"].search([("company_id", "=", self.company.id), ("branch_id", "=", self.branch.id)], limit=1)
        self.assertEqual(assignment.runtime_agent_id, "agent-a")

    def test_persisted_binding_reopens_with_same_context(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=20))
        reopened = self.env["print_gateway.binding"].browse(binding.id)
        self.assertEqual((reopened.company_id.id, reopened.branch_id.id, reopened.runtime_agent_id, reopened.printer_id), (self.company.id, self.branch.id, "agent-a", "printer-a"))

    def test_find_for_prefers_branch_binding(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=30))
        found = self.env["print_gateway.binding"].find_for(self.company, "order", report=self._report(), branch=self.branch)
        self.assertEqual(found.id, binding.id)

    def test_agent_change_clears_printer(self):
        record = self.env["print_gateway.binding"].new(self._values())
        record._onchange_runtime_agent_id()
        self.assertFalse(record.printer_id)

    def test_branch_change_clears_agent_printer_and_destination(self):
        record = self.env["print_gateway.binding"].new(self._values())
        record._onchange_branch_id()
        self.assertFalse(record.runtime_agent_id)
        self.assertFalse(record.printer_id)
        self.assertFalse(record.report_id)
