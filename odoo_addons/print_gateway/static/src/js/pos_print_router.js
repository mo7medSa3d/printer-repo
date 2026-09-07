/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/store/pos_store";

patch(PosStore.prototype, {
    /**
     * Central POS print interception.
     *
     * The server decides whether Gateway printing is enabled for the order.
     * When enabled, any routing/Gateway failure is surfaced and native POS
     * printing is deliberately NOT attempted. Native printing is used only
     * when the server explicitly reports that Gateway printing is disabled.
     */
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const orderId = order?.id;
        if (orderId) {
            try {
                const result = await this.data.call("pos.order", "action_print_gateway_receipt", [[orderId]]);
                if (result?.gateway_enabled) {
                    this.notification.add(
                        result.message || "Print job queued.",
                        { type: "success" },
                    );
                    return result;
                }
                if (result?.native) {
                    return super.printReceipt({ order, basic, printBillActionTriggered });
                }
                throw new Error("Print Gateway returned an invalid POS print response.");
            } catch (error) {
                this.notification.add(
                    error?.message || "Print Gateway printing failed.",
                    { type: "danger" },
                );
                throw error;
            }
        }

        return super.printReceipt({ order, basic, printBillActionTriggered });
    },
});
