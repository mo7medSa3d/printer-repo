/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";

async function elementToJpeg(element) {
    const canvas = await htmlToCanvas(element, { addClass: "pos-receipt-print" });
    return canvas.toDataURL("image/jpeg").replace("data:image/jpeg;base64,", "");
}

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            const error = new Error("No POS order is available for printing.");
            this.notification.add(error.message, { type: "danger" });
            throw error;
        }

        let gatewayEnabled = false;
        const serverOrderId = currentOrder.id;
        if (serverOrderId) {
            gatewayEnabled = await this.data.call(
                "pos.order",
                "is_gateway_printing_enabled",
                [[serverOrderId]],
                {},
                true
            );
        }

        // Preserve Odoo's native print path exactly when Gateway printing is disabled.
        // Gateway-specific synchronization/validation belongs only to the Gateway path.
        if (gatewayEnabled !== true) {
            return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
        }

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
            const receipt = renderToElement("point_of_sale.OrderReceipt", {
                order: currentOrder,
                basic_receipt: Boolean(basic),
            });
            const image = await elementToJpeg(receipt);
            const result = await this.data.call(
                "pos.order",
                "action_print_gateway_receipt",
                [[orderId]],
                { image },
                true
            );
            this.notification.add(result?.message || "Print job accepted.", { type: "success" });
            if (!printBillActionTriggered) {
                const count = currentOrder.nb_print ? currentOrder.nb_print + 1 : 1;
                await this.data.write("pos.order", [orderId], { nb_print: count });
            }
            return result;
        } catch (error) {
            this.notification.add(error?.message || "Print Gateway printing failed.", { type: "danger" });
            throw error;
        }
    },

    getOrderData(order, reprint) {
        const data = super.getOrderData(order, reprint);
        return { ...data, __gateway_order_id: order.id, __gateway_reprint: Boolean(reprint) };
    },

    generateOrderChange(order, orderChange, categories, reprint = false) {
        if (!orderChange.__gateway_print_id) {
            orderChange.__gateway_print_id = crypto.randomUUID();
        }
        return super.generateOrderChange(order, orderChange, categories, reprint);
    },

    async generateReceiptsDataToPrint(orderData, changes, orderChange) {
        const receiptsData = await super.generateReceiptsDataToPrint(orderData, changes, orderChange);
        const operationId = orderData?.__gateway_print_id;
        if (!operationId) {
            return receiptsData;
        }
        // One order change can produce multiple real kitchen tickets (NEW, CANCELLED,
        // NOTE UPDATE, and/or note-only). Each physical ticket must have its own stable
        // idempotency identity, while retries reuse the same derived identities.
        receiptsData.forEach((receiptData, index) => {
            receiptData.orderData.__gateway_print_id = `${operationId}:${index}`;
        });
        return receiptsData;
    },

    async printOrderChanges(data, printer) {
        const orderId = data?.orderData?.__gateway_order_id;
        const reprint = Boolean(data?.orderData?.__gateway_reprint);
        const operationId = data?.orderData?.__gateway_print_id;
        if (!orderId) {
            return super.printOrderChanges(data, printer);
        }
        const gatewayEnabled = await this.data.call("pos.order", "is_gateway_printing_enabled", [[orderId]], {}, true);
        if (gatewayEnabled !== true) {
            return super.printOrderChanges(data, printer);
        }
        try {
            const receipt = renderToElement("point_of_sale.OrderChangeReceipt", { data });
            const image = await elementToJpeg(receipt);
            const result = await this.data.call(
                "pos.order",
                "action_print_gateway_kitchen",
                [[orderId]],
                { printer_id: printer.config.id, image, reprint, operation_id: operationId },
                true
            );
            return {
                successful: ["queued", "submitted", "claimed", "printing", "success"].includes(result?.status),
                warningCode: undefined,
            };
        } catch (error) {
            this.notification.add(error?.message || "Kitchen / Preparation printing failed.", { type: "danger" });
            return {
                successful: false,
                canRetry: true,
                message: { title: "Print Gateway", body: error?.message || "Kitchen / Preparation printing failed." },
            };
        }
    },
});
