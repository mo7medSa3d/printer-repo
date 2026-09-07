/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        const orderId = currentOrder?.id;
        if (!orderId) {
            const error = new Error("POS order is not synchronized; Gateway printing cannot continue.");
            this.notification.add(error.message, { type: "danger" });
            throw error;
        }
        try {
            const result = await this.data.call("pos.order", "action_print_gateway_receipt", [[orderId]]);
            if (result?.gateway_enabled) {
                this.notification.add(result.message || "Print job accepted.", { type: "success" });
                return result;
            }
            if (result?.native) {
                return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
            }
            throw new Error("Print Gateway returned an invalid POS print response.");
        } catch (error) {
            this.notification.add(error?.message || "Print Gateway printing failed.", { type: "danger" });
            throw error;
        }
    },

    async printChanges() {
        const order = this.getOrder();
        if (order?.id) {
            const gatewayEnabled = await this.data.call("pos.order", "is_gateway_printing_enabled", [[order.id]]);
            if (gatewayEnabled === true) {
                const error = new Error("POS kitchen/order-preparation printing is not configured through the Print Gateway binding.");
                this.notification.add(error.message, { type: "danger" });
                throw error;
            }
        }
        return super.printChanges(...arguments);
    },
});
