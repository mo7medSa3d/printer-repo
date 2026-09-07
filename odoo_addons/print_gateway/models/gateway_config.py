# -*- coding: utf-8 -*-
"""Gateway connection configuration owned by the Odoo integration layer."""

from urllib.parse import urlparse

import requests

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayConfig(models.Model):
    _name = "print_gateway.gateway_config"
    _description = "Print Gateway Configuration"
    _order = "company_id"

    company_id = fields.Many2one(
        "res.company",
        string="Company",
        required=True,
        default=lambda self: self.env.company,
        ondelete="restrict",
        index=True,
    )
    enabled = fields.Boolean(string="Gateway Printing Enabled", default=False)
    gateway_url = fields.Char(string="Gateway URL", required=True)
    gateway_api_key = fields.Char(
        string="API Key",
        copy=False,
        groups="base.group_system",
        password=True,
    )
    last_test_at = fields.Datetime(readonly=True)
    last_test_status = fields.Selection(
        [("success", "Success"), ("failed", "Failed")], readonly=True
    )
    last_test_error = fields.Text(readonly=True)

    _company_unique = models.Constraint(
        "UNIQUE(company_id)",
        "Only one Print Gateway configuration is allowed per Odoo company.",
    )

    @api.constrains("gateway_url")
    def _check_gateway_url(self):
        for record in self:
            self._validate_gateway_url(record.gateway_url)

    @staticmethod
    def _validate_gateway_url(value):
        if not value or not isinstance(value, str):
            raise ValidationError(_("Gateway URL is required."))
        raw = value.strip()
        if len(raw) > 2048 or "\\r" in raw or "\\n" in raw:
            raise ValidationError(_("Gateway URL is invalid."))
        parsed = urlparse(raw)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValidationError(_("Gateway URL must use HTTP or HTTPS and include a host."))
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValidationError(_("Gateway URL must not contain credentials, query parameters, or fragments."))
        if parsed.path not in ("", "/"):
            raise ValidationError(_("Gateway URL must be the Gateway origin, without an API path."))
        return raw.rstrip("/")

    def _gateway_base(self):
        self.ensure_one()
        return self._validate_gateway_url(self.gateway_url)

    def _gateway_headers(self):
        self.ensure_one()
        if not self.gateway_api_key:
            raise ValidationError(_("Gateway API key is not configured."))
        return {
            "Authorization": "Bearer %s" % self.gateway_api_key,
            "Accept": "application/json",
            "Cache-Control": "no-store",
        }

    def _check_admin(self):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can change Gateway configuration."))

    def write(self, vals):
        if set(vals).intersection({"gateway_url", "gateway_api_key", "enabled"}):
            self._check_admin()
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        for vals in vals_list:
            if not vals.get("company_id"):
                vals["company_id"] = self.env.company.id
            self._validate_gateway_url(vals.get("gateway_url"))
        return super().create(vals_list)

    def action_test_connection(self):
        self.ensure_one()
        self._check_admin()
        base = self._gateway_base()
        try:
            response = requests.get(
                "%s/api/health" % base,
                headers=self._gateway_headers(),
                timeout=10,
                allow_redirects=False,
            )
            data = response.json() if response.content else {}
            ok = response.status_code == 200 and isinstance(data, dict) and data.get("ok") is True
            if not ok:
                raise ValidationError(_("Gateway health check failed (HTTP %s).") % response.status_code)
            self.write({
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "success",
                "last_test_error": False,
            })
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Gateway Connection"),
                    "message": _("Gateway is reachable and authenticated."),
                    "type": "success",
                    "sticky": False,
                },
            }
        except ValidationError:
            self.write({
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": _("Gateway health check failed."),
            })
            raise
        except requests.RequestException:
            self.write({
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": _("Gateway is unavailable or the connection timed out."),
            })
            raise ValidationError(_("Gateway is unavailable or the connection timed out."))
        except ValueError:
            self.write({
                "last_test_at": fields.Datetime.now(),
                "last_test_status": "failed",
                "last_test_error": _("Gateway returned an invalid health response."),
            })
            raise ValidationError(_("Gateway returned an invalid health response."))
