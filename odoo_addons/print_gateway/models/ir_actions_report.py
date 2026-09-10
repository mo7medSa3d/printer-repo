# -*- coding: utf-8 -*-
"""Backend report interception through the single Print Gateway router."""

from odoo import models


class IrActionsReportGateway(models.Model):
    _inherit = "ir.actions.report"

    def report_action(self, docids, data=None, config=True):
        self.ensure_one()
        normalized_ids = docids if isinstance(docids, (list, tuple)) else [docids] if docids else []
        records = self.env[self.model].browse(normalized_ids).exists() if normalized_ids else self.env[self.model]
        # Same read authorization as the /report/download controller: when
        # the gateway dispatches a rendered document out of the database
        # perimeter, the caller must be allowed to read every source record.
        # Native Odoo rendering below is already ACL-protected; this closes
        # the gateway-dispatch side of the same action.
        if records:
            records.check_access("read")
        router = self.env["print_gateway.print_router"]

        route = router.route_report(self, records, data=data)
        if not route.get("native"):
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": "Print Job Accepted",
                    "message": route["message"],
                    "type": "success",
                    "sticky": False,
                },
            }
        return super().report_action(docids, data=data, config=config)
