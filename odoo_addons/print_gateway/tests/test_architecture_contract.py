import json
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from odoo.exceptions import ValidationError
except ImportError:
    ValidationError = Exception

try:
    from odoo.tests.common import TransactionCase
except ImportError:
    TransactionCase = unittest.TestCase


ADDON = Path(__file__).resolve().parents[1]
MODELS = ADDON / "models"
VIEWS = ADDON / "views"
CONTROLLERS = ADDON / "controllers"


class TestPrintGatewayArchitectureContract(TransactionCase):
    def test_final_integration_models_include_only_ollama_owned_binding_layer(self):
        allowed = {
            "__init__.py",
            "binding.py",
            "gateway_config.py",
            "runtime_assignment.py",
            "ir_actions_report.py",
            "pos_order.py",
            "pos_session.py",
            "print_job.py",
            "print_router.py",
            "print_policy.py",
            "print_intent.py",
            "stock_picking.py",
            "account_move.py",
        }
        self.assertEqual({path.name for path in MODELS.glob("*.py")}, allowed)

    def test_legacy_user_owned_architecture_files_are_gone(self):
        forbidden = {
            "branch.py", "branch_contract.py", "branch_multicompany.py", "branch_security.py",
            "destination.py", "document_type.py", "printer.py", "agent.py", "printer_binding.py",
            "report_mapping.py", "async_report.py", "native_branch_bridge.py", "odoo19_compat.py",
        }
        self.assertTrue(forbidden.isdisjoint({path.name for path in MODELS.glob("*.py")}))

    def test_legacy_views_are_gone(self):
        forbidden = {
            "branch_views.xml", "destination_views.xml", "document_type_views.xml", "printer_views.xml",
            "agent_views.xml", "printer_binding_views.xml", "report_mapping_views.xml", "ir_actions_report_views.xml",
        }
        self.assertTrue(forbidden.isdisjoint({path.name for path in VIEWS.glob("*.xml")}))

    def test_runtime_binding_model_is_odata_owned_and_opaque(self):
        source = (MODELS / "runtime_assignment.py").read_text(encoding="utf-8")
        binding = (MODELS / "binding.py").read_text(encoding="utf-8")
        self.assertIn('_name = "print_gateway.runtime_agent_assignment"', source)
        self.assertIn('"res.company"', source)
        self.assertIn("parent_id", source)
        self.assertIn("runtime_agent_id = fields.Char", source)
        self.assertIn("branch_id = fields.Many2one", binding)
        self.assertIn("runtime_agent_id = fields.Char", binding)
        self.assertIn('"res.company"', binding)
        self.assertIn('"print_gateway.gateway_config"', binding)
        self.assertNotIn("gateway_branch_id", binding)

    def test_odoo_addon_does_not_define_gateway_business_catalog_models(self):
        source = "\n".join(path.read_text(encoding="utf-8") for path in MODELS.glob("*.py"))
        forbidden = (
            '"print_gateway.branch"',
            '"print_gateway.destination"',
            '"print_gateway.document_type"',
            '"print_gateway.printer_binding"',
            '"print_gateway.odoo_company"',
        )
        for token in forbidden:
            self.assertNotIn(token, source)

    def test_gateway_config_remains_connection_only_in_ui(self):
        source = (VIEWS / "gateway_config_views.xml").read_text(encoding="utf-8")
        self.assertIn('field name="gateway_url"', source)
        self.assertIn('field name="gateway_api_key"', source)
        self.assertNotIn('widget="gateway_runtime_agent"', source)
        self.assertNotIn('string="Runtime Assignment"', source)

    def test_binding_view_exposes_explicit_business_and_runtime_relationship(self):
        source = (VIEWS / "binding_views.xml").read_text(encoding="utf-8")
        for label in (
            'string="Odoo Company"', 'string="Odoo Branch"',
            'string="Gateway Runtime Agent"', 'string="Gateway Runtime Printer"',
            'string="Business Context"', 'string="Runtime Target"', 'string="Routing"',
        ):
            self.assertIn(label, source)
        self.assertIn('widget="gateway_runtime_agent"', source)
        self.assertIn('widget="gateway_runtime_printer"', source)

    def test_direct_pos_controller_is_loaded_and_runtime_printer_controller_is_loaded(self):
        pos_controller = (CONTROLLERS / "pos.py").read_text(encoding="utf-8")
        init_source = (CONTROLLERS / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("/pos/sale_details_report", pos_controller)
        self.assertIn("route_render_target", pos_controller)
        self.assertIn("from . import pos", init_source)
        self.assertIn("from . import runtime_printers", init_source)

    def test_runtime_printer_controller_uses_odoo_19_jsonrpc_route(self):
        source = (CONTROLLERS / "runtime_printers.py").read_text(encoding="utf-8")
        self.assertIn("type='jsonrpc'", source)
        self.assertNotIn("type='json'", source)
        self.assertIn("company_id=None, branch_id=None, agent_id=None", source)

    def test_manifest_contains_final_integration_entrypoints(self):
        manifest = (ADDON / "__manifest__.py").read_text(encoding="utf-8")
        for forbidden in (
            "branch_views.xml", "destination_views.xml", "document_type_views.xml", "printer_views.xml",
            "agent_views.xml", "printer_binding_views.xml", "report_mapping_views.xml", "report_mappings.xml",
        ):
            self.assertNotIn(forbidden, manifest)
        self.assertIn("point_of_sale._assets_pos", manifest)
        self.assertIn("application': True", manifest)

    def test_router_has_native_branch_context_but_no_gateway_branch_contract(self):
        source = (MODELS / "print_router.py").read_text(encoding="utf-8")
        self.assertNotIn("gateway_branch_id", source)
        self.assertIn("_binding_scope", source)
        self.assertIn("branch = company if company.parent_id else False", source)
        self.assertIn('"binding"', source)

    def test_gateway_config_keeps_legacy_agent_reference_non_authoritative(self):
        source = (MODELS / "gateway_config.py").read_text(encoding="utf-8")
        self.assertIn("gateway_url", source)
        self.assertIn("gateway_api_key", source)
        self.assertIn("runtime_agent_id", source)
        self.assertIn("New branch bindings do not use this field as their source of truth.", source)
        self.assertNotIn("printer_id", source)

    def test_binding_model_enforces_root_company_invariant(self):
        source = (MODELS / "binding.py").read_text(encoding="utf-8")
        self.assertIn('@api.constrains("company_id", "branch_id")', source)
        self.assertIn("def _check_company_hierarchy(self):", source)
        self.assertIn("record.company_id.parent_id", source)
        self.assertIn("Odoo Company must be a root Company, not a Branch.", source)
        self.assertIn("Odoo Branch must belong directly to the selected Odoo Company.", source)

    def test_branch_restricted_user_can_query_gateway_config_and_route(self):
        """Test that a user restricted strictly to Branch B (company_ids=[branch.id])
        can read gateway config and execute routing without AccessError.
        """
        if not hasattr(self, "env"):
            self.skipTest("Odoo runtime environment not available")
        root_company = self.env.company
        branch = self.env["res.company"].create({
            "name": "Branch Test Context",
            "parent_id": root_company.id,
        })
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config:
            with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
                config = self.env["print_gateway.gateway_config"].create({
                    "company_id": root_company.id,
                    "gateway_url": "https://gateway.example.com",
                    "enabled": True,
                })

        branch_user = self.env["res.users"].create({
            "name": "Branch Restricted Cashier",
            "login": "branch_cashier_%s" % branch.id,
            "company_id": branch.id,
            "company_ids": [(6, 0, [branch.id])],
        })

        router = self.env["print_gateway.print_router"].with_user(branch_user).with_company(branch)
        cfg = router._gateway_config(branch)
        self.assertTrue(cfg)
        self.assertEqual(cfg.id, config.id)

    def test_runtime_controller_cross_branch_idor_forbidden(self):
        """Test that user in Branch A requesting Branch B receives Forbidden (403)."""
        if not hasattr(self, "env"):
            self.skipTest("Odoo runtime environment not available")
        from werkzeug.exceptions import Forbidden
        from odoo.addons.print_gateway.controllers.runtime_printers import PrintGatewayRuntimePrinterController

        root_company = self.env.company
        branch_a = self.env["res.company"].create({
            "name": "Branch Alpha",
            "parent_id": root_company.id,
        })
        branch_b = self.env["res.company"].create({
            "name": "Branch Beta",
            "parent_id": root_company.id,
        })

        controller = PrintGatewayRuntimePrinterController()

        env_a = self.env(context=dict(self.env.context, allowed_company_ids=[branch_a.id]))
        with self.assertRaises(Forbidden):
            controller._scope(company_id=root_company.id, branch_id=branch_b.id, env=env_a)

    def test_binding_constraints_do_not_contain_network_calls(self):
        source = (MODELS / "binding.py").read_text(encoding="utf-8")
        scope_idx = source.find("def _check_runtime_scope")
        binding_idx = source.find("def _check_binding")
        runtime_scope_code = source[scope_idx:binding_idx]
        self.assertNotIn("_validate_runtime_target", runtime_scope_code)
        self.assertNotIn("requests.", runtime_scope_code)
        self.assertIn("def action_verify_remote_hardware(self):", source)

    def test_runtime_printer_controller_guards_sudo_with_forbidden(self):
        source = (CONTROLLERS / "runtime_printers.py").read_text(encoding="utf-8")
        self.assertIn("from werkzeug.exceptions import Forbidden", source)
        self.assertIn("raise Forbidden", source)
        self.assertIn(".sudo().search", source)

    def test_binding_model_defines_effective_company_id(self):
        source = (MODELS / "binding.py").read_text(encoding="utf-8")
        self.assertIn("effective_company_id = fields.Many2one(", source)
        self.assertIn("def _compute_effective_company_id(self):", source)
        self.assertIn("record.effective_company_id = record.branch_id or record.company_id", source)

    def test_print_job_state_machine_transition_matrix(self):
        """BEHAVIORAL: the ORM must reject illegal transitions (no copy of the
        table under test - deleting the model's guard must make THIS red)."""
        source = (MODELS / "print_job.py").read_text(encoding="utf-8")
        self.assertIn("_VALID_TRANSITIONS", source)
        self.assertIn("Invalid print job state transition", source)

        # Real enforced behavior: writing an illegal transition raises, and
        # the row is unchanged afterwards. Terminal rows cannot regress,
        # successes cannot be rewritten, unknown outcomes cannot be revived.
        if not hasattr(self, "env"):
            self.skipTest("Odoo runtime environment not available")
        root_company = self.env.company
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config:
            with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
                config = self.env["print_gateway.gateway_config"].create({
                    "company_id": root_company.id,
                    "gateway_url": "https://gateway.example.com",
                    "enabled": True,
                })
        base_vals = {
            "company_id": root_company.id,
            "gateway_config_id": config.id,
            "printer_id": "printer-state-machine",
            "destination": "State Machine Dest",
            "document_type": "label",
            "payload": json.dumps({"type": "raw", "protocol": "raw", "encoding": "base64", "data": "dGVzdA=="}),
            "idempotency_key": "test_state_machine_behavioral_01",
        }
        job = self.env["print_gateway.print_job"].create(base_vals)

        # queued -> claimed is legal; claimed -> queued is NOT (regression).
        job.write({"status": "submitted"})
        job.write({"status": "claimed"})
        with self.assertRaises(ValidationError):
            job.write({"status": "queued"})
        self.assertEqual(job.status, "claimed")

        # printing -> success is the only exit to success...
        job.write({"status": "printing"})
        with self.assertRaises(ValidationError):
            job.write({"status": "queued"})
        job.write({"status": "success"})
        # ...and success is terminal: nothing can leave it.
        for illegal in ("queued", "submitted", "claimed", "printing", "failed", "partial", "unknown"):
            with self.assertRaises(ValidationError):
                job.write({"status": illegal})
        self.assertEqual(job.status, "success")


    def test_branch_restricted_user_raw_command_submits_without_access_error(self):
        """A standard print operator (group_user, outbox read-only) must be
        able to submit a raw print end-to-end: the trusted service boundary
        elevates creation/submission internally while the model ACL stays
        read-only. Any AccessError here is a P0 regression."""
        if not hasattr(self, "env"):
            self.skipTest("Odoo runtime environment not available")
        from unittest.mock import MagicMock
        root_company = self.env.company
        branch = self.env["res.company"].create({
            "name": "Branch Submit Context",
            "parent_id": root_company.id,
        })
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", root_company.id)], limit=1)
        if not config:
            with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
                config = self.env["print_gateway.gateway_config"].create({
                    "company_id": root_company.id,
                    "gateway_url": "https://gateway.example.com",
                    "enabled": True,
                })
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        self.assertTrue(report)
        binding = self.env["print_gateway.binding"].create({
            "company_id": root_company.id,
            "branch_id": branch.id,
            "destination_type": "report",
            "destination_report_id": report.id,
            "report_id": report.id,
            "runtime_agent_id": "agt-branch-submit",
            "printer_id": "printer-branch-submit",
            "printer_protocol": "escpos",
            "enabled": True,
        })
        branch_user = self.env["res.users"].create({
            "name": "Branch Submit Operator",
            "login": "branch_submit_%s" % branch.id,
            "company_id": branch.id,
            "company_ids": [(6, 0, [branch.id])],
        })
        self.assertFalse(branch_user.has_group("base.group_system"))

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"jobId": "gw_branch_submit_1", "status": "queued"}
        router = self.env["print_gateway.print_router"].with_user(branch_user).with_company(branch)
        with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None), \
             patch("requests.post", return_value=mock_resp):
            res = router.route_raw_command(
                "\x1b@Branch submit ticket",
                protocol="escpos",
                binding=binding,
                company=branch,
                document_type="receipt",
                idempotency_key="test_branch_submit_key_01",
            )
        self.assertTrue(res.get("gateway_enabled"))
        job = self.env["print_gateway.print_job"].browse(res["job_id"])
        self.assertTrue(job.exists())
        self.assertEqual(job.status, "submitted")
        self.assertEqual(job.gateway_job_id, "gw_branch_submit_1")
        self.assertEqual(job.company_id, branch)
