# -*- coding: utf-8 -*-
"""Backend report interception for the central Print Gateway router."""

from odoo import models


class IrActionsReportGateway(models.Model):
    _inherit = "ir.actions.report"

    def report_action(self, docids, data=None, config=True):
        self.ensure_one()
        normalized_ids = docids if isinstance(docids, (list, tuple)) else [docids] if docids else []
        if not normalized_ids:
            return super().report_action(docids, data=data, config=config)

        records = self.env[self.model].browse(normalized_ids).exists()
        if not records:
            return super().report_action(docids, data=data, config=config)

        route = self.env["print_gateway.print_router"].route_report(
            self,
            records,
            data=data,
        )
        if route.get("native"):
            return super().report_action(docids, data=data, config=config)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": "Print Job Queued",
                "message": route["message"],
                "type": "success",
                "sticky": False,
            },
        }
