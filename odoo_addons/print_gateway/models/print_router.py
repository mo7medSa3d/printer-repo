# -*- coding: utf-8 -*-
"""Central Odoo print-routing service.

This model is the single integration entry point for supported Gateway print
operations. Business ownership stays in Odoo; the Gateway receives only the
resolved printer and printable payload plus routing metadata.
"""

from odoo import api, models, _
from odoo.exceptions import ValidationError


class PrintGatewayRouter(models.AbstractModel):
    _name = "print_gateway.print_router"
    _description = "Print Gateway Central Router"

    @api.model
    def route_report(self, report, records, data=None, *, notification=True):
        """Route an Odoo report without ever falling back to browser printing.

        Native Odoo rendering remains available only when the report mapping
        explicitly disables Gateway printing.
        """
        report.ensure_one()
        records = records.exists()
        if not records:
            raise ValidationError(_("Cannot print an empty report."))

        if not report._should_route_via_gateway(record=records[0]):
            return {"gateway_enabled": False, "native": True}

        job = report._enqueue_async_gateway_report(records.ids, data=data)
        if not job:
            raise ValidationError(_(
                "Gateway printing is enabled for %s, but no print operation was created."
            ) % report.display_name)

        return {
            "gateway_enabled": True,
            "native": False,
            "status": "queued",
            "job_id": job.id,
            "message": _("Print job queued successfully."),
            "notification": notification,
        }

    @api.model
    def route_pos_receipt(self, order):
        """Route a synchronized POS receipt through the same report pipeline."""
        order.ensure_one()
        if not order.id:
            raise ValidationError(_("The POS order has not been synchronized."))

        report = self.env.ref("point_of_sale.action_report_receipt", raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The standard POS receipt report is unavailable."))

        result = self.route_report(report, order)
        if result.get("native"):
            return {"gateway_enabled": False, "native": True}
        return result
