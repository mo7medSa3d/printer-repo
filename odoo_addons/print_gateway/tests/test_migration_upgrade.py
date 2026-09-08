import importlib.util
import unittest
from pathlib import Path
from unittest.mock import MagicMock

try:
    from odoo.tests.common import TransactionCase
except ImportError:
    TransactionCase = unittest.TestCase


class TestPrintGatewayMigrationUpgrade(TransactionCase):
    """Automated upgrade migration test validating schema evolution and preventing UndefinedColumn exceptions."""

    def test_post_migrate_preserves_runtime_agent_id_column(self):
        """Ensure post-migrate.py does not drop runtime_agent_id from print_gateway_gateway_config."""
        migration_path = Path(__file__).resolve().parents[1] / "migrations" / "19.0.2.1.0" / "post-migrate.py"
        self.assertTrue(migration_path.exists(), "Migration script post-migrate.py must exist")

        source = migration_path.read_text(encoding="utf-8")
        self.assertNotIn(
            "DROP COLUMN IF EXISTS runtime_agent_id",
            source,
            "post-migrate.py must NOT drop runtime_agent_id because it is declared on the active ORM model",
        )

        import sys
        odoo_mocked = False
        if "odoo" not in sys.modules:
            mock_odoo = MagicMock()
            sys.modules["odoo"] = mock_odoo
            sys.modules["odoo.upgrade"] = mock_odoo.upgrade
        spec = importlib.util.spec_from_file_location("post_migrate_19_0_2_1_0", migration_path)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        finally:
            if odoo_mocked:
                sys.modules.pop("odoo", None)
                sys.modules.pop("odoo.upgrade", None)

        # Verify migrate function can execute with a cursor without raising UndefinedColumn
        mock_cr = MagicMock()
        mock_cr.fetchone.return_value = ("runtime_agent_id",)
        module.migrate(mock_cr, "19.0.2.1.0")

        # Verify it executed the binding update/migration
        executed_sqls = [call[0][0] for call in mock_cr.execute.call_args_list]
        self.assertTrue(
            any("UPDATE print_gateway_binding" in sql or "INSERT INTO print_gateway_binding" in sql for sql in executed_sqls),
            "Migration must copy legacy runtime_agent_id into root fallback bindings",
        )
        self.assertFalse(
            any("branch_id = company_id" in sql.lower() for sql in executed_sqls),
            "Migration must never assign branch_id = company_id",
        )
        # Verify it did not execute DROP COLUMN
        self.assertFalse(
            any("DROP COLUMN" in sql.upper() for sql in executed_sqls),
            "Migration must not issue DROP COLUMN on runtime_agent_id",
        )

    def test_orm_gateway_config_runtime_agent_id_field_access(self):
        """Verify ORM model can access runtime_agent_id without UndefinedColumn errors."""
        if not hasattr(self, "env"):
            self.skipTest("Odoo runtime environment not available")
        config_model = self.env["print_gateway.gateway_config"]
        self.assertIn("runtime_agent_id", config_model._fields)

        # Check field declaration properties
        field = config_model._fields["runtime_agent_id"]
        self.assertEqual(field.type, "char")
        self.assertFalse(field.copy)

        # Query database table column definition
        self.env.cr.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'print_gateway_gateway_config'
              AND column_name = 'runtime_agent_id'
        """)
        row = self.env.cr.fetchone()
        # In test environment, the column must be present if the table exists
        self.env.cr.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_name = 'print_gateway_gateway_config'
        """)
        table_row = self.env.cr.fetchone()
        if table_row:
            self.assertTrue(row, "Column runtime_agent_id must exist in print_gateway_gateway_config")
