# -*- coding: utf-8 -*-
{
    'name': 'Odoo Print Gateway',
    'version': '19.0.2.1.0',
    'summary': 'Silent Odoo 19 printing through an external Gateway and runtime Agent',
    'description': """
Odoo Print Gateway — Integration Only

Odoo owns business records and print intent. This module stores the Gateway
connection, Odoo-owned print bindings, branch-to-runtime-agent assignments,
and a durable print outbox. The Gateway owns agents, runtime printers,
heartbeats, and execution state.

Gateway-enabled printing is silent: there is no browser print fallback. Native
Odoo printing occurs only when Gateway printing is explicitly disabled.
    """,
    'author': 'Odoo Print Gateway',
    'website': 'https://github.com/mo7medSa3d/printer-repo',
    'category': 'Tools',
    'depends': ['base', 'sale', 'account', 'stock', 'purchase', 'point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'security/security.xml',
        'views/gateway_config_views.xml',
        'views/binding_views.xml',
        'views/print_job_views.xml',
        'views/menu.xml',
        'data/cron.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'print_gateway/static/src/js/pos_print_router.js',
            'print_gateway/static/src/js/pos_sale_details_router.js',
        ],
        'web.assets_backend': [
            'print_gateway/static/src/js/runtime_printer_field.js',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}