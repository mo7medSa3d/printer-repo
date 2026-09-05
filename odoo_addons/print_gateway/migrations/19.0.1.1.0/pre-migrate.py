from odoo.upgrade import util


def migrate(cr, version):
    """Remove constraints created by legacy _sql_constraints definitions.

    Odoo 19 uses models.Constraint attributes. The old ORM-created constraint
    names are removed before the new declarations are installed, preventing
    duplicate database constraints during module upgrade.
    """
    legacy_constraints = (
        ('print_gateway_branch', 'name_company_unique'),
        ('print_gateway_destination', 'name_branch_unique'),
        ('print_gateway_document_type', 'name_branch_unique'),
        ('print_gateway_agent', 'gateway_agent_id_unique'),
        ('print_gateway_printer', 'gateway_printer_id_unique'),
        ('print_gateway_printer_binding', 'priority_branch_dest_doctype_unique'),
        ('print_gateway_print_job', 'branch_idempotency_unique'),
        ('print_gateway_report_mapping', 'priority_unique'),
    )
    for table, name in legacy_constraints:
        util.remove_constraint(cr, table, name, warn=False)
