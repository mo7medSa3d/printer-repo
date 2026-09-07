# -*- coding: utf-8 -*-
from pathlib import Path

from odoo.tests.common import TransactionCase


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"


class TestPrintGatewayArchitectureContract(TransactionCase):
    def test_only_expected_models_are_present(self):
        names = sorted(path.name for path in MODELS.glob("*.py"))
        self.assertEqual(
            names,
            [
                "__init__.py",
                "binding.py",
                "gateway_config.py",
                "ir_actions_report.py",
                "pos_order.py",
                "pos_session.py",
                "print_job.py",
                "print_router.py",
            ],
        )

    def test_binding_has_no_gateway_branch_identifier_contract(self):
        source = (MODELS / "binding.py").read_text(encoding="utf-8")
        self.assertNotIn("gateway_branch_id", source)
        self.assertNotIn("branch_id", source)
        self.assertIn('"binding"', source)

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

    def test_gateway_config_exposes_url_api_key_and_opaque_runtime_agent_for_assignment(self):
        source = (MODELS / "gateway_config.py").read_text(encoding="utf-8")
        self.assertIn("gateway_url", source)
        self.assertIn("gateway_api_key", source)
        self.assertIn("runtime_agent_id", source)
        self.assertNotIn("gateway_branch_id", source)
        self.assertNotIn("printer_id", source)
