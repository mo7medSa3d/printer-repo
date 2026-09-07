from pathlib import Path

from odoo.tests.common import TransactionCase


ADDON = Path(__file__).resolve().parents[1]
MODELS = ADDON / "models"
VIEWS = ADDON / "views"


class TestPrintGatewayArchitectureContract(TransactionCase):
    def test_only_final_integration_models_are_present(self):
        allowed = {
            "__init__.py",
            "binding.py",
            "gateway_config.py",
            "ir_actions_report.py",
            "pos_order.py",
            "print_job.py",
            "print_router.py",
        }
        self.assertEqual({path.name for path in MODELS.glob("*.py")}, allowed)

    def test_legacy_user_owned_architecture_files_are_gone(self):
        forbidden = {
            "branch.py",
            "branch_contract.py",
            "branch_multicompany.py",
            "branch_security.py",
            "destination.py",
            "document_type.py",
            "printer.py",
            "agent.py",
            "printer_binding.py",
            "report_mapping.py",
            "async_report.py",
            "native_branch_bridge.py",
            "odoo19_compat.py",
        }
        self.assertTrue(forbidden.isdisjoint({path.name for path in MODELS.glob("*.py")}))

    def test_legacy_views_are_gone(self):
        forbidden = {
            "branch_views.xml",
            "destination_views.xml",
            "document_type_views.xml",
            "printer_views.xml",
            "agent_views.xml",
            "printer_binding_views.xml",
            "report_mapping_views.xml",
            "ir_actions_report_views.xml",
        }
        self.assertTrue(forbidden.isdisjoint({path.name for path in VIEWS.glob("*.xml")}))

    def test_manifest_contains_only_final_integration_entrypoints(self):
        manifest = (ADDON / "__manifest__.py").read_text(encoding="utf-8")
        for forbidden in (
            "branch_views.xml",
            "destination_views.xml",
            "document_type_views.xml",
            "printer_views.xml",
            "agent_views.xml",
            "printer_binding_views.xml",
            "report_mapping_views.xml",
            "report_mappings.xml",
        ):
            self.assertNotIn(forbidden, manifest)
        self.assertIn("point_of_sale._assets_pos", manifest)

    def test_pos_router_never_calls_native_print_when_gateway_is_enabled(self):
        source = (ADDON / "static" / "src" / "js" / "pos_print_router.js").read_text(encoding="utf-8")
        gateway_block = source.split("if (result?.gateway_enabled)", 1)[1].split("if (result?.native)", 1)[0]
        self.assertNotIn("super.printReceipt", gateway_block)
        self.assertIn("action_print_gateway_receipt", source)

    def test_report_interceptor_delegates_only_through_central_router(self):
        source = (MODELS / "ir_actions_report.py").read_text(encoding="utf-8")
        self.assertIn('self.env["print_gateway.print_router"].route_report', source)
        self.assertIn('if route.get("native"):', source)
        self.assertNotIn("async_report", source)

    def test_router_has_no_gateway_branch_identifier_contract(self):
        source = (MODELS / "print_router.py").read_text(encoding="utf-8")
        self.assertNotIn("gateway_branch_id", source)
        self.assertNotIn("branch_id", source)
        self.assertIn('"binding"', source)

    def test_gateway_config_exposes_only_url_and_api_key_for_normal_connection(self):
        source = (MODELS / "gateway_config.py").read_text(encoding="utf-8")
        self.assertIn("gateway_url", source)
        self.assertIn("gateway_api_key", source)
        self.assertNotIn("gateway_branch_id", source)
        self.assertNotIn("agent_id", source)
        self.assertNotIn("printer_id", source)
