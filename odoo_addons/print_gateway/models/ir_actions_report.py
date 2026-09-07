# -*- coding: utf-8 -*-
"""Backend report interception for the single Print Gateway router."""

from odoo import models, _
from odoo.exceptions import ValidationError


class IrActionsReportGateway(models.Model):
    _inherit = "ir.actions.report"

    def report_action(self, docids, data=None, config=True):
        self.ensure_one()
        normalized_ids = docids if isinstance(docids, (list, tuple)) else [docids] if docids else []
        records = self.env[self.model].browse(normalized_ids).exists() if normalized_ids else self.env[self.model]
        gateway = self.env["print_gateway.print_router"]._gateway_config(self.env.company)
        if not gateway:
            return super().report_action(docids, data=data, config=config)
        if not records:
            raise ValidationError(_("Gateway printing is enabled, but the report has no printable records."))

        route = self.env["print_gateway.print_router"].route_report(self, records, data=data)
        if route.get("native"):
            # The router is the authority on the enabled/disabled decision.
            return super().report_action(docids, data=data, config=config)
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Print Job Accepted"),
                "message": route["message"],
                "type": "success",
                "sticky": False,
            },
        }
