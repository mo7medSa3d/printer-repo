/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { formatDateTime } from "@web/core/l10n/dates";

// `@web/core/l10n/dates` does not export DateTime in Odoo 19 (it reads the
// luxon global privately). Take DateTime from the same global, mirroring
// core's own `const { DateTime, Settings } = luxon;` idiom.
const { DateTime } = luxon;
import { SaleDetailsButton } from "@point_of_sale/app/components/navbar/sale_details_button/sale_details_button";
import { renderToElement } from "@web/core/utils/render";
import { htmlToCanvas } from "@point_of_sale/app/services/render_service";

async function elementToJpeg(element, renderService) {
    const renderFn = renderService?.htmlToCanvas || htmlToCanvas;
    const canvas = await renderFn(element, { addClass: "pos-receipt-print" });
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

patch(SaleDetailsButton.prototype, {
    async onClick() {
        const sessionId = this.pos.session?.id;
        if (!sessionId) {
            return super.onClick();
        }

        const enabled = await this.pos.data.call(
            "pos.session",
            "is_gateway_printing_enabled",
            [[sessionId]],
            {},
            true
        );
        if (enabled !== true) {
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
                    date: formatDateTime(DateTime.now()),
                    pos: this.pos,
                    formatCurrency: this.pos.formatCurrency || this.pos.env.utils.formatCurrency,
                })
            );
            const image = await elementToJpeg(report, this.env.services.render);
            const result = await this.pos.data.call(
                "pos.session",
                "action_print_gateway_sale_details",
                [[sessionId]],
                { image },
                true
            );
            if (!result?.gateway_enabled) {
                throw new Error("Print Gateway returned an invalid Sale Details response.");
            }
            if (["unknown", "partial"].includes(result?.status)) {
                this.env.services.notification.add(
                    "Print outcome unknown - the report may or may not have printed. Check the printer before reprinting.",
                    { type: "warning", sticky: true }
                );
            } else {
                this.env.services.notification.add(
                    result.message || "Sale Details print job accepted by the Gateway queue.",
                    { type: "success" }
                );
            }
            return result;
        } catch (error) {
            // Fail-safe parity with the receipt router: notify once and
            // return false instead of re-throwing, so a Gateway failure
            // cannot freeze the Sale Details button with a double dialog.
            this.env.services.notification.add(error?.message || "Sale Details printing failed.", { type: "danger" });
            return false;
        }
    },
});
