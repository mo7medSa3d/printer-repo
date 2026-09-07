/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { formatDateTime } from "@web/core/l10n/dates";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";
import { SaleDetailsButton } from "@point_of_sale/app/components/navbar/sale_details_button/sale_details_button";

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
            const gatewayEnabled = await this.data.call("pos.order", "is_gateway_printing_enabled", [[orderId]], {}, true);
            if (gatewayEnabled === true) {
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
            }
            return super.printReceipt({ order: currentOrder, basic, printBillActionTriggered });
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
        const result = super.generateOrderChange(order, orderChange, categories, reprint);
        result.orderData.__gateway_print_id = orderChange.__gateway_print_id;
        return result;
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

patch(SaleDetailsButton.prototype, {
    async onClick() {
        const sessionId = this.pos.session?.id;
        if (!sessionId) {
            return super.onClick();
        }

        const gatewayEnabled = await this.pos.data.call(
            "pos.session",
            "is_gateway_printing_enabled",
            [[sessionId]],
            {},
            true
        );
        if (gatewayEnabled !== true) {
            return super.onClick();
        }

        try {
            const saleDetails = await this.pos.data.call(
                "report.point_of_sale.report_saledetails",
                "get_sale_details",
                [false, false, false, [sessionId]]
            );
            const report = renderToElement(
                "point_of_sale.SaleDetailsReport",
                Object.assign({}, saleDetails, {
                    date: formatDateTime(luxon.DateTime.now()),
                    pos: this.pos,
                    formatCurrency: this.pos.env.utils.formatCurrency,
                })
            );
            const image = await elementToJpeg(report);
            const result = await this.pos.data.call(
                "pos.session",
                "action_print_gateway_sale_details",
                [[sessionId]],
                { image },
                true
            );
            this.pos.notification.add(result?.message || "Sale Details print job accepted.", { type: "success" });
            return result;
        } catch (error) {
            this.pos.notification.add(error?.message || "Sale Details printing failed.", { type: "danger" });
            throw error;
        }
    },
});
