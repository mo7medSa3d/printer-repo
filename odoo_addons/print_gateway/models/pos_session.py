# -*- coding: utf-8 -*-
"""POS session entry points for client/direct report printing."""

from odoo import models, _
from odoo.exceptions import ValidationError


class PosSessionGatewayPrinting(models.Model):
    _inherit = "pos.session"

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        config = self.env["print_gateway.gateway_config"].search([("company_id", "=", self.company_id.id)], limit=1)
        return bool(config and config.enabled)

    def action_print_gateway_sale_details(self, date_start=False, date_stop=False):
        self.ensure_one()
        report = self.env.ref("point_of_sale.sale_details_report", raise_if_not_found=False)
        if not report:
            raise ValidationError(_("The POS sale details report is unavailable."))
        render_target = self.env["report.point_of_sale.report_saledetails"]
        return self.env["print_gateway.print_router"].route_render_target(
            "point_of_sale.sale_details_report",
            render_target,
            company=self.company_id,
            document_type="report:point_of_sale.sale_details_report",
            explicit_destination=self.config_id,
            context_values={"date_start": date_start, "date_stop": date_stop},
        )