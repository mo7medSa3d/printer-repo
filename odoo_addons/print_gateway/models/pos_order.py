# -*- coding: utf-8 -*-
"""Server-side POS integration for Gateway printing."""

from odoo import models, _
from odoo.exceptions import ValidationError


class PosOrderGatewayPrinting(models.Model):
    _inherit = "pos.order"

    def action_print_gateway_receipt(self, image):
        self.ensure_one()
        if not image:
            raise ValidationError(_("The rendered POS receipt image is required."))
        return self.env["print_gateway.print_router"].route_pos_receipt(self, image)

    def action_print_gateway_kitchen(self, printer_id, image, reprint=False, operation_id=None):
        self.ensure_one()
        if not printer_id:
            raise ValidationError(_("The Odoo Kitchen / Preparation printer is required."))
        try:
            printer = self.env["pos.printer"].browse(int(printer_id)).exists()
        except (TypeError, ValueError) as exc:
            raise ValidationError(_("The selected Kitchen / Preparation printer is invalid.")) from exc
        if not printer:
            raise ValidationError(_("The selected Kitchen / Preparation printer no longer exists."))
        if printer.company_id != self.env.company:
            raise ValidationError(_("The selected Kitchen / Preparation printer belongs to another active Odoo company."))
        if printer.company_id != self.company_id:
            raise ValidationError(_("The selected Kitchen / Preparation printer belongs to another Odoo company."))
        return self.env["print_gateway.print_router"].route_kitchen_print(
            self, printer, image, reprint=bool(reprint), idempotency_key=operation_id,
        )

    def is_gateway_printing_enabled(self):
        self.ensure_one()
        if self.company_id != self.env.company:
            raise ValidationError(_("Gateway printing must use the active Odoo company."))
        return bool(self.env["print_gateway.print_router"]._gateway_config(self.env.company))

    def _action_trigger_print_policies(self):
        policy_model = self.env["print_gateway.policy"].sudo()
        intent_model = self.env["print_gateway.intent"].sudo()

        policies = policy_model.search([
            ("model_id.model", "=", "pos.order"),
            ("event_type", "=", "pos_order_paid"),
            ("active", "=", True),
        ], order="priority asc, id asc")

        if policies:
            for order in self:
                for policy in policies:
                    if policy.matches_record(order):
                        intent_model.create_and_route(policy, order, "pos_order_paid")

    def _process_saved_order(self, draft):
        res = super()._process_saved_order(draft)
        if not draft:
            self._action_trigger_print_policies()
        return res

