/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { SaleDetailsButton } from "@point_of_sale/app/components/navbar/sale_details_button/sale_details_button";

patch(SaleDetailsButton.prototype, {
    async onClick() {
        const enabled = await this.pos.data.call(
            "pos.session",
            "is_gateway_printing_enabled",
            [[this.pos.session.id]],
            {},
            true
        );
        if (enabled !== true) {
            return super.onClick();
        }
        try {
            const result = await this.pos.data.call(
                "pos.session",
                "action_print_gateway_sale_details",
                [[this.pos.session.id]],
                {},
                true
            );
            if (result?.gateway_enabled) {
                this.env.services.notification.add(result.message || "Sale details print job accepted.", { type: "success" });
                return result;
            }
            throw new Error("Print Gateway returned an invalid Sale Details response.");
        } catch (error) {
            this.env.services.notification.add(error?.message || "Sale details printing failed.", { type: "danger" });
            throw error;
        }
    },
});
