from pathlib import Path

from odoo.tests.common import TransactionCase


ADDON = Path(__file__).resolve().parents[1]
MODELS = ADDON / "models"
VIEWS = ADDON / "views"
CONTROLLERS = ADDON / "controllers"


class TestPrintGatewayArchitectureContract(TransactionCase):
    def test_only_final_integration_models_are_present(self):
        allowed = {
            "__init__.py",
            "binding.py",
            "gateway_config.py",
            "ir_actions_report.py",
            "pos_order.py",
            "pos_session.py",
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
        self.assertIn('"pos.session", "is_gateway_printing_enabled"', source)
        self.assertIn("basic_receipt: Boolean(basic)", source)
        gateway_call = source.index("action_print_gateway_receipt")
        native_call = source.index("return super.printReceipt")
        sync_call = source.index("this.syncAllOrders")
        self.assertLess(native_call, gateway_call)
        self.assertLess(sync_call, gateway_call)
        gateway_suffix = source[gateway_call:]
        self.assertNotIn("return super.printReceipt", gateway_suffix)
        self.assertNotIn("window.print", gateway_suffix)

    def test_kitchen_router_uses_stable_per_receipt_operation_identity(self):
        source = (ADDON / "static" / "src" / "js" / "pos_print_router.js").read_text(encoding="utf-8")
        self.assertIn("orderChange.__gateway_print_id = crypto.randomUUID()", source)
        self.assertIn("const result = super.generateOrderChange(order, orderChange, categories, reprint)", source)
        self.assertIn("result.orderData.__gateway_print_id = orderChange.__gateway_print_id", source)
        self.assertIn("generateReceiptsDataToPrint(orderData, changes, orderChange)", source)
        self.assertIn('`${operationId}:${index}`', source)
        self.assertIn("action_print_gateway_kitchen", source)
        self.assertIn('"pos.session", "is_gateway_printing_enabled"', source)

    def test_sale_details_router_intercepts_client_hardware_print_path(self):
        source = (ADDON / "static" / "src" / "js" / "pos_sale_details_router.js").read_text(encoding="utf-8")
        self.assertIn("SaleDetailsButton", source)
        self.assertIn("action_print_gateway_sale_details", source)
        self.assertNotIn("hardwareProxy.printer.printReceipt", source)

    def test_report_interceptor_delegates_only_through_central_router(self):
        source = (MODELS / "ir_actions_report.py").read_text(encoding="utf-8")
        self.assertIn('router = self.env["print_gateway.print_router"]', source)
        self.assertIn("route = router.route_report(self, records, data=data)", source)
        self.assertIn('if not route.get("native"):', source)
        self.assertIn("return super().report_action(docids, data=data, config=config)", source)
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
