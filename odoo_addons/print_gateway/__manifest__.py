# -*- coding: utf-8 -*-
{
    'name': 'Odoo Print Gateway',
    'version': '1.0.0',
    'summary': 'Multi-branch print gateway integration: branches, destinations, document types, printer bindings',
    'description': """
Odoo Print Gateway — End-to-End Print Routing

Business configuration source for printing:
  Branch -> Destination + Document Type -> Printer Binding -> Physical Printer -> Agent

Features:
  - Branch configuration (Cairo, Giza, etc.)
  - Destination configuration (POS, Kitchen, Warehouse)
  - Document type configuration (receipt, invoice, label, order)
  - Printer records/status synced from Gateway
  - Agent records/status synced from Gateway
  - Printer bindings with priority fallback
  - Gateway connection / API key configuration per branch
  - Synchronization with Gateway (cron + manual)
  - Print job history/status
  - Sale order / invoice print integration via Gateway routing
    (no hardcoded physical printer IDs)
    """,
    'author': 'Odoo Print Gateway',
    'website': 'https://example.com',
    'category': 'Tools',
    'depends': ['base', 'sale', 'account', 'stock', 'purchase', 'point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'security/security.xml',
        'views/branch_views.xml',
        'views/destination_views.xml',
        'views/document_type_views.xml',
        'views/printer_views.xml',
        'views/agent_views.xml',
        'views/printer_binding_views.xml',
        'views/print_job_views.xml',
        'views/report_mapping_views.xml',
        'views/ir_actions_report_views.xml',
        'views/menu.xml',
        'data/cron.xml',
        'data/report_mappings.xml',
    ],
    # Brand layer only: `--pg-*` design tokens + a skin scoped to this
    # add-on's own views (.o_pg_view / .o_pg_form / .o_pg_list /
    # .o_pg_kanban). No JS, no widget overrides, no changes to Odoo's
    # own Bootstrap variables — other apps are untouched.
    'assets': {
        'web.assets_backend': [
            'print_gateway/static/src/scss/print_gateway_tokens.scss',
            'print_gateway/static/src/scss/print_gateway_backend.scss',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
