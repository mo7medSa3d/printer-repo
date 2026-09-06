# -*- coding: utf-8 -*-
"""Security hardening for branch Gateway credentials."""

from urllib.parse import urlparse

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayBranchSecurity(models.Model):
    _inherit = 'print_gateway.branch'

    gateway_api_key = fields.Char(
        groups='base.group_system',
        copy=False,
    )

    def read(self, fields):
        # ``groups`` on a field only hides it from the web UI (fields_get /
        # view rendering) — a direct RPC ``read`` still returns the value to
        # any user with model read access (base.group_user can read
        # print_gateway.branch). The gateway API key grants full access to
        # the branch's data on the Gateway, so it must never leave the
        # server for non-admins. Admins are unaffected; crons run as
        # OdooBot which is a system admin.
        if not self.env.user.has_group('base.group_system'):
            if 'gateway_api_key' in fields:
                raise AccessError(_(
                    'Only Odoo system administrators can read the Gateway API key.'
                ))
        return super().read(fields)

    @api.constrains('gateway_url')
    def _check_gateway_url_https(self):
        for rec in self:
            if not rec.gateway_url:
                continue
            parsed = urlparse(rec.gateway_url.strip())
            if parsed.scheme.lower() != 'https' or not parsed.netloc:
                raise ValidationError(_(
                    'Gateway URL must use HTTPS and include a valid host for branch %s.'
                ) % rec.name)

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
