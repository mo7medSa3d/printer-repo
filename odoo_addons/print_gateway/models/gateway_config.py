# -*- coding: utf-8 -*-
"""Minimal Gateway connection configuration for the Odoo integration."""

import ipaddress
import os
import socket
from urllib.parse import urlparse

import requests

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayConfig(models.Model):
    _name = "print_gateway.gateway_config"
    _description = "Print Gateway Configuration"
    _order = "company_id"

    company_id = fields.Many2one(
        "res.company", string="Company", required=True,
        default=lambda self: self.env.company, ondelete="restrict", index=True,
    )
    enabled = fields.Boolean(string="Gateway Printing Enabled", default=False)
    gateway_url = fields.Char(string="Gateway URL", required=True)
    gateway_api_key = fields.Char(
        string="API Key", copy=False, groups="base.group_system",
    )
    runtime_agent_id = fields.Char(
        string="Legacy Runtime Agent Reference",
        copy=False,
        groups="base.group_system",
        help="Backward-compatible opaque Gateway runtime-agent reference from the earlier configuration model. New branch bindings do not use this field as their source of truth.",
    )
    last_test_at = fields.Datetime(readonly=True)
    last_test_status = fields.Selection(
        [("draft", "Untested"), ("success", "Success"), ("failed", "Failed"),
         ("revoked", "Revoked / Deleted on Gateway")],
        readonly=True, default="draft",
    )
    last_test_error = fields.Text(readonly=True)

    _company_unique = models.Constraint(
        "UNIQUE(company_id)",
        "Only one Print Gateway configuration is allowed per Odoo company.",
    )

    @staticmethod
    def _allowed_private_hosts():
        raw = os.environ.get("ODOO_PRINT_GATEWAY_ALLOWED_HOSTS", "")
        return {item.strip().lower().rstrip(".") for item in raw.split(",") if item.strip()}

    @classmethod
    def _validate_gateway_host(cls, hostname, *, resolve=False):
        hostname = hostname.strip().rstrip(".").lower()
        allow_private = os.environ.get("ODOO_PRINT_GATEWAY_ALLOW_PRIVATE") == "1"
        explicitly_allowed = hostname in cls._allowed_private_hosts()
        try:
            addresses = {ipaddress.ip_address(hostname)}
        except ValueError:
            if not resolve:
                return
            try:
                addresses = {
                    ipaddress.ip_address(item[4][0])
                    for item in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
                }
            except OSError as exc:
                raise ValidationError(_("Gateway hostname cannot be resolved.")) from exc
        for address in addresses:
            if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast or address.is_unspecified:
                if not (allow_private and explicitly_allowed):
                    raise ValidationError(_("Private or local Gateway addresses require explicit deployment allow-listing."))

    @classmethod
    def _validate_gateway_url(cls, value, *, resolve_host=False):
        if not value or not isinstance(value, str):
            raise ValidationError(_("Gateway URL is required."))
        raw = value.strip()
        if len(raw) > 2048 or "\r" in raw or "\n" in raw:
            raise ValidationError(_("Gateway URL is invalid."))
        parsed = urlparse(raw)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            raise ValidationError(_("Gateway URL must use HTTP or HTTPS and include a host."))
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValidationError(_("Gateway URL must not contain credentials, query parameters, or fragments."))
        if parsed.path not in ("", "/"):
            raise ValidationError(_("Gateway URL must be the Gateway origin, without an API path."))
        cls._validate_gateway_host(parsed.hostname, resolve=resolve_host)
        return raw.rstrip("/")

    @api.constrains("gateway_url")
    def _check_gateway_url(self):
        for record in self:
            self._validate_gateway_url(record.gateway_url)

    @api.constrains("runtime_agent_id")
    def _check_runtime_agent_id(self):
        for record in self:
            if record.runtime_agent_id and (not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip()):
                raise ValidationError(_("Legacy Runtime Agent must be a non-empty Gateway agent ID."))

    def _gateway_base(self, *, for_request=False):
        self.ensure_one()
        return self._validate_gateway_url(self.gateway_url, resolve_host=for_request)

    def _gateway_headers(self):
        self.ensure_one()
        if not self.gateway_api_key:
            raise ValidationError(_("Gateway API key is not configured."))
        return {
            "Authorization": "Bearer %s" % self.gateway_api_key,
            "Accept": "application/json",
            "Cache-Control": "no-store",
            "X-Odoo-Database": self.env.cr.dbname,
        }

    def _check_admin(self):
        if not self.env.user.has_group("base.group_system"):
            raise AccessError(_("Only Odoo system administrators can change Gateway configuration."))

    def write(self, vals):
        if set(vals).intersection({"gateway_url", "gateway_api_key", "enabled", "company_id", "runtime_agent_id"}):
            self._check_admin()
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        for vals in vals_list:
            vals.setdefault("company_id", self.env.company.id)
            self._validate_gateway_url(vals.get("gateway_url"))
        return super().create(vals_list)

    def action_test_connection(self):
        self.ensure_one()
        self._check_admin()
        try:
            response = requests.get(
                "%s/api/odoo/health" % self._gateway_base(for_request=True),
                headers=self._gateway_headers(),
                timeout=(5, 10),
                allow_redirects=False,
            )
            body = response.json() if response.content else {}
            if response.status_code == 401:
                # The installation API key was revoked or deleted on the
                # Gateway. Mark it explicitly, explain it, and disable
                # printing immediately so no further jobs are attempted
                # with a dead credential.
                self.write({
                    "last_test_at": fields.Datetime.now(),
                    "last_test_status": "revoked",
                    "last_test_error": _("API Key has been revoked or deleted from the Gateway. Printing is disabled. Paste a new key or press Clear / Remove Key, then test again."),
                    "enabled": False,
                })
                raise ValidationError(_("API Key has been revoked or deleted from the Gateway."))
            if response.status_code != 200 or not isinstance(body, dict) or body.get("ok") is not True:
                raise ValidationError(_("Gateway connection test failed (HTTP %s).") % response.status_code)
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "success", "last_test_error": False})
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {"title": _("Gateway Connection"), "message": _("Gateway is reachable and the installation API key is valid."), "type": "success", "sticky": False},
            }
        except ValidationError as exc:
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": str(exc)[:4000]})
            raise
        except requests.RequestException as exc:
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": _("Gateway is unavailable or the connection timed out.")})
            raise ValidationError(_("Gateway is unavailable or the connection timed out.")) from exc
        except ValueError as exc:
            self.write({"last_test_at": fields.Datetime.now(), "last_test_status": "failed", "last_test_error": _("Gateway returned an invalid health response.")})
            raise ValidationError(_("Gateway returned an invalid health response.")) from exc

    def action_clear_api_key(self):
        """Remove the stored installation API key and reset test state."""
        self.ensure_one()
        self._check_admin()
        self.write({
            "gateway_api_key": False,
            "last_test_status": "draft",
            "last_test_error": False,
            "enabled": False,
        })
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {"title": _("API Key"), "message": _("The installation API key was removed. Printing is disabled until a new key is configured and tested."), "type": "warning", "sticky": False},
        }

    def action_open_pairing_wizard(self):
        self.ensure_one()
        self._check_admin()
        return {
            "type": "ir.actions.act_window",
            "name": _("Pair New Agent"),
            "res_model": "print_gateway.pair_agent_wizard",
            "view_mode": "form",
            "target": "new",
            "context": {"default_config_id": self.id},
        }


class PrintGatewayPairAgentWizard(models.TransientModel):
    _name = "print_gateway.pair_agent_wizard"
    _description = "Assign Runtime Agent Wizard"

    config_id = fields.Many2one("print_gateway.gateway_config", string="Gateway Configuration", required=True)
    company_id = fields.Many2one("res.company", related="config_id.company_id", readonly=True)
    branch_id = fields.Many2one(
        "res.company", string="Target Branch",
        domain="[('parent_id', '=', company_id)]",
        required=True,
    )
    agent_id = fields.Char(
        string="Runtime Agent ID",
        help="Identifier of an active Agent registered with the Central Gateway.",
    )
    pairing_code = fields.Char(
        string="Agent Reference / ID",
        help="Identifier or name of the Agent to assign to this branch.",
    )

    def action_confirm_pairing(self):
        self.ensure_one()
        target = (self.agent_id or self.pairing_code or "").strip()
        if not target:
            raise ValidationError(_("Please provide a valid Runtime Agent ID."))
        config = self.config_id
        try:
            response = requests.get(
                "%s/api/odoo/agents" % config._gateway_base(for_request=True),
                headers=config._gateway_headers(),
                timeout=(5, 10),
                allow_redirects=False,
            )
            if response.status_code in (401, 403):
                raise ValidationError(_("Gateway authentication failed. Please check your Gateway API key."))
            if response.status_code != 200:
                raise ValidationError(_("Gateway agent discovery failed (HTTP %s).") % response.status_code)
            body = response.json() if response.content else {}
            agents_list = body.get("agents") if isinstance(body, dict) else []
            matched = next(
                (a for a in agents_list if isinstance(a, dict) and (a.get("id") == target or a.get("name") == target)),
                None,
            )
            if not matched:
                available = [a.get("id") for a in agents_list if isinstance(a, dict) and a.get("id")]
                raise ValidationError(
                    _("Agent '%s' not found on Central Gateway. Registered active agents: %s")
                    % (target, ", ".join(available) if available else _("none"))
                )
            if matched.get("lifecycle") != "active":
                raise ValidationError(
                    _("Agent '%s' cannot be assigned because its status is '%s'. Only active agents are allowed.")
                    % (matched.get("name") or target, matched.get("lifecycle"))
                )
            resolved_agent_id = matched["id"]
            assignment_model = self.env["print_gateway.runtime_agent_assignment"]
            existing = assignment_model.search([
                ("company_id", "=", config.company_id.id),
                ("branch_id", "=", self.branch_id.id),
            ], limit=1)
            if existing:
                existing.write({"runtime_agent_id": resolved_agent_id, "enabled": True})
            else:
                assignment_model.create({
                    "company_id": config.company_id.id,
                    "branch_id": self.branch_id.id,
                    "runtime_agent_id": resolved_agent_id,
                    "enabled": True,
                })
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": _("Agent Assigned Successfully"),
                    "message": _("Agent %s assigned to %s.") % (resolved_agent_id, self.branch_id.name),
                    "type": "success",
                    "sticky": False,
                },
            }
        except ValidationError:
            raise
        except requests.RequestException as exc:
            raise ValidationError(_("Gateway connection timed out while querying registered agents.")) from exc


