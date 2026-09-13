/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";

function canvasToJpeg(canvas) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Strip any Data-URL prefix variant (some browsers emit charset/parameters);
    // the payload layer only accepts raw base64.
    return canvas.toDataURL("image/jpeg", 0.65).replace(/^data:image\/[a-z]+;base64,/, "");
}

async function elementToJpeg(element) {
    const canvas = await htmlToCanvas(element, { addClass: "pos-receipt-print" });
    return canvasToJpeg(canvas);
}

async function renderReceiptImage(pos, currentOrder, basic = false) {
    const renderer = pos.env?.services?.renderer || pos.printer?.renderer;
    const props = {
        data: typeof currentOrder.export_for_printing === "function" ? currentOrder.export_for_printing() : currentOrder,
        order: currentOrder,
        formatCurrency: pos.env?.utils?.formatCurrency || pos.formatCurrency || ((amount) => String(amount)),
        basic_receipt: Boolean(basic),
    };

    if (renderer && typeof renderer.toJpeg === "function") {
        try {
            return await renderer.toJpeg(OrderReceipt, props, { addClass: "pos-receipt-print" });
        } catch (err) {
            console.warn("renderer.toJpeg failed, falling back to toCanvas/toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toCanvas === "function") {
        try {
            const canvas = await renderer.toCanvas(OrderReceipt, props, { addClass: "pos-receipt-print" });
            return canvasToJpeg(canvas);
        } catch (err) {
            console.warn("renderer.toCanvas failed, falling back to toHtml:", err);
        }
    }

    if (renderer && typeof renderer.toHtml === "function") {
        try {
            const element = await renderer.toHtml(OrderReceipt, props);
            return await elementToJpeg(element);
        } catch (err) {
            console.warn("renderer.toHtml failed, falling back to renderToElement:", err);
        }
    }

    // Direct template fallback if renderer service is unavailable:
        const receipt = renderToElement("point_of_sale.OrderReceipt", props);
    return await elementToJpeg(receipt);
}

patch(PosStore.prototype, {
    async printReceipt({ order, basic = false, printBillActionTriggered = false } = {}) {
        const currentOrder = order || this.getOrder();
        if (!currentOrder) {
            this.notification.add("No POS order is available for printing.", { type: "danger" });
            return false;
        }

        try {
            const sessionId = this.session?.id;
            const gatewayEnabled = sessionId
                ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
                : false;

            if (gatewayEnabled !== true) {
                return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
            }

            // Decoupled order sync: attempt non-blocking sync if needed, but never stall or throw
            if (!currentOrder.isSynced) {
                try {
                    await this.syncAllOrders({ orders: [currentOrder], force: false, throw: false });
                } catch (syncErr) {
                    console.warn("Background order synchronization skipped or pending:", syncErr);
                }
            }

            const orderId = currentOrder.id;
            if (!orderId) {
                console.warn("POS order has no server identifier; cannot print via Gateway without synced record:", currentOrder.uuid || currentOrder.name);
                this.notification.add("Order must be synchronized to the backend before Gateway receipt printing.", { type: "warning" });
                return false;
            }

            const image = await renderReceiptImage(this, currentOrder, basic);
            const result = await this.data.call(
                "pos.order",
                "action_print_gateway_receipt",
                [[orderId]],
                { image },
                true
            );

            // Truthful feedback: "submitted" means QUEUED for the agent, not
            // printed; "unknown" means the outcome cannot be trusted.
            if (["unknown", "partial"].includes(result?.status)) {
                this.notification.add(
                    "Print outcome unknown - the receipt may or may not have printed. Check the printer before reprinting.",
                    { type: "warning", sticky: true }
                );
            } else if (result?.status === "failed") {
                this.notification.add(
                    result?.message || "The Gateway could not accept this receipt. Check the Print Jobs list for the reason.",
                    { type: "danger" }
                );
            } else {
                this.notification.add(
                    result?.message || "Receipt sent to the Gateway queue - watch the Print Jobs list for the final result.",
                    { type: "success" }
                );
            }

            if (!printBillActionTriggered) {
                const count = currentOrder.nb_print ? currentOrder.nb_print + 1 : 1;
                try {
                    await this.data.silentCall("pos.order", "write", [[orderId], { nb_print: count }]);
                } catch (writeErr) {
                    console.warn("Failed to record receipt print count:", writeErr);
                }
            }
            return result;
        } catch (error) {
            // Fail-safe: display user notification and return false, NEVER re-throw to avoid freezing POS UI
            this.notification.add(error?.message || "Print Gateway printing failed.", { type: "danger" });
            return false;
        }
    },

    getOrderData(order, reprint) {
        const data = super.getOrderData(order, reprint);
        return {
            ...data,
            __gateway_order_id: order.id,
            __gateway_session_id: this.session?.id,
            __gateway_reprint: Boolean(reprint),
        };
    },

    generateOrderChange(order, orderChange, categories, reprint = false) {
        if (!orderChange.__gateway_print_id) {
            orderChange.__gateway_print_id = crypto.randomUUID();
        }
        const result = super.generateOrderChange(order, orderChange, categories, reprint);
        if (result?.orderData) {
            result.orderData.__gateway_print_id = orderChange.__gateway_print_id;
        }
        return result;
    },

    async generateReceiptsDataToPrint(orderData, changes, orderChange) {
        const receiptsData = await super.generateReceiptsDataToPrint(orderData, changes, orderChange);
        const operationId = orderData?.__gateway_print_id;
        if (!operationId) {
            return receiptsData;
        }
        receiptsData.forEach((receiptData, index) => {
            receiptData.orderData.__gateway_print_id = `${operationId}:${index}`;
        });
        return receiptsData;
    },

    async printOrderChanges(data, printer) {
        const orderId = data?.orderData?.__gateway_order_id;
        const sessionId = data?.orderData?.__gateway_session_id;
        const reprint = Boolean(data?.orderData?.__gateway_reprint);
        const operationId = data?.orderData?.__gateway_print_id;

        const gatewayEnabled = sessionId
            ? await this.data.call("pos.session", "is_gateway_printing_enabled", [[sessionId]], {}, true)
            : false;
        if (gatewayEnabled !== true) {
            return super.printOrderChanges(data, printer);
        }
        if (!orderId) {
            const message = "POS order has no server identifier; Gateway kitchen printing cannot continue.";
            this.notification.add(message, { type: "danger" });
            return {
                successful: false,
                canRetry: true,
                message: { title: "Print Gateway", body: message },
            };
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
