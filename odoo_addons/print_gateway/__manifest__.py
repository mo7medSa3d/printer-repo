# -*- coding: utf-8 -*-
{
    'name': 'Odoo Print Gateway',
    'version': '19.0.1.3.0',
    'summary': 'Silent print routing for Odoo 19 through a central Gateway router',
    'description': """
Odoo Print Gateway — Silent Print Routing

Odoo remains the business source of truth. The module resolves print intent
and bindings, renders the printable payload, and submits durable operations to
an external Gateway. The Gateway owns agent/runtime execution.

Gateway-enabled report and POS printing never falls back to browser printing.
Native Odoo printing remains available only when Gateway routing is explicitly
disabled for the active context.
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
        'point_of_sale._assets_pos': [
            'print_gateway/static/src/js/pos_print_router.js',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
