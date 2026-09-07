/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            const error = new Error("No POS order is available for printing.");
            this.notification.add(error.message, { type: "danger" });
            throw error;
        }

        // Odoo's native printer accepts unsynced orders. Gateway printing cannot,
        // because the central router resolves an existing Odoo business record.
        // Force a server sync before routing rather than silently falling back.
        if (!currentOrder.isSynced) {
            try {
                await this.syncAllOrders({ orders: [currentOrder], force: true, throw: true });
            } catch (error) {
                const message = "POS order could not be synchronized; Gateway printing cannot continue.";
                this.notification.add(message, { type: "danger" });
                throw new Error(message, { cause: error });
            }
        }

        const orderId = currentOrder.id;
        if (!orderId) {
            const error = new Error("POS order has no server identifier; Gateway printing cannot continue.");
            this.notification.add(error.message, { type: "danger" });
            throw error;
        }

        try {
            const result = await this.data.call("pos.order", "action_print_gateway_receipt", [[orderId]], {}, true);
            if (result?.gateway_enabled) {
                this.notification.add(result.message || "Print job accepted.", { type: "success" });
                if (!printBillActionTriggered && currentOrder.isSynced) {
                    const count = currentOrder.nb_print ? currentOrder.nb_print + 1 : 1;
                    await this.data.write("pos.order", [orderId], { nb_print: count });
                }
                return result;
            }
            if (result?.native) {
                // Native/browser printing is explicitly allowed only while Gateway is disabled.
                return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
            }
            throw new Error("Print Gateway returned an invalid POS print response.");
        } catch (error) {
            this.notification.add(error?.message || "Print Gateway printing failed.", { type: "danger" });
            throw error;
        }
    },

    async printChanges(...args) {
        const order = args[0] || this.getOrder();
        if (order?.id) {
            const gatewayEnabled = await this.data.call("pos.order", "is_gateway_printing_enabled", [[order.id]], {}, true);
            if (gatewayEnabled === true) {
                // Kitchen/order-preparation printing is a separate Odoo 19 execution path
                // from printReceipt(). It is intentionally fail-closed until a dedicated
                // Gateway kitchen binding/payload contract is configured.
                const error = new Error("POS kitchen/order-preparation printing is not configured through the Print Gateway binding.");
                this.notification.add(error.message, { type: "danger" });
                throw error;
            }
        }
        return super.printChanges(...args);
    },
});
