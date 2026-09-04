# -*- coding: utf-8 -*-
"""Security hardening for branch Gateway credentials."""

from odoo import fields, models, _
from odoo.exceptions import AccessError


class PrintGatewayBranchSecurity(models.Model):
    _inherit = 'print_gateway.branch'

    # A masked password widget is presentation-only. Field groups are what
    # prevent regular Odoo users from reading the secret through ORM/API.
    gateway_api_key = fields.Char(
        groups='base.group_system',
        copy=False,
    )

    def _check_gateway_configuration_access(self):
        if not self.env.user.has_group('base.group_system'):
            raise AccessError(_(
                'Only Odoo system administrators can manage Print Gateway connection settings.'
            ))

    def action_test_connection(self):
        self._check_gateway_configuration_access()
        return super().action_test_connection()

    def action_sync_from_gateway(self):
        self._check_gateway_configuration_access()
        return super().action_sync_from_gateway()

    def action_sync_to_gateway(self):
        self._check_gateway_configuration_access()
        return super().action_sync_to_gateway()
