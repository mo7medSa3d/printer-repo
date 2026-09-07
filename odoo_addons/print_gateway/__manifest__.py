# -*- coding: utf-8 -*-
{
    'name': 'Odoo Print Gateway',
    'version': '19.0.1.2.0',
    'summary': 'Print routing for existing Odoo companies/branches with local Gateway agents',
    'description': """
Odoo Print Gateway — End-to-End Print Routing

Ownership:
  Odoo owns the existing company/branch hierarchy and all print configuration.
  The Gateway mirrors that identity and owns runtime agents, physical printers,
  heartbeats and print execution.

Business configuration source for printing:
  Existing Odoo Branch/Company -> Destination + Document Type -> Printer Binding

Features:
  - Discovers existing Odoo companies/branches; never creates Odoo branches
  - Destination configuration (POS, Kitchen, Warehouse)
  - Document type configuration (receipt, invoice, label, order)
  - Printer records/status synced from Gateway
  - Agent records/status synced from Gateway
  - Printer bindings with priority fallback
  - Gateway connection / API key configuration
  - Synchronization with Gateway (cron + manual)
  - Print job history/status
  - Sale order / invoice print integration via Gateway routing
    (no hardcoded physical printer IDs)
  - Odoo 19-compatible list/form/kanban view definitions
    """,
    'author': 'Odoo Print Gateway',
    'website': 'https://github.com/mo7medSa3d/printer-repo',
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
        'data/cron.xml',
        'data/report_mappings.xml',
    ],
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
