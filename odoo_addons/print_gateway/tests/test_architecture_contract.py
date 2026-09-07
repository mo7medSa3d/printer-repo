from pathlib import Path

from odoo.tests.common import TransactionCase


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
