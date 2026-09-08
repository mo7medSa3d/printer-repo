/** @odoo-module **/

import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";

/**
 * OWL 3 silent report interceptor.
 * Catches ir.actions.report execution in the web client and silently dispatches
 * through the Print Gateway if a binding exists for the current branch/company context.
 *
 * Strict Fail-Closed Policy:
 * - If NO binding exists: returns false to allow standard Odoo report download.
 * - If a binding DOES exist and dispatch fails: displays an error notification and
 *   returns true to cancel native browser PDF download, preventing hardware bypass.
 */
async function silentPrintReportHandler(action, options, env) {
    if (action.type !== "ir.actions.report") {
        return false;
    }

    const orm = env.services.orm;
    const notification = env.services.notification;

    try {
        const res = await orm.call(
            "print_gateway.binding",
            "dispatch_report_action",
            [],
            {
                report_name: action.report_name,
                res_ids: action.context?.active_ids || (action.context?.active_id ? [action.context.active_id] : []),
                context: action.context || {},
            }
        );

        if (res && res.dispatched) {
            notification.add(
                res.message || _t("Sent silently to Gateway printer: %s", res.printer_name || "Printer"),
                { type: "success" }
            );
            return true; // Cancel default browser PDF dialog
        }

        if (res && res.has_binding && !res.dispatched) {
            notification.add(
                res.error || _t("Gateway print failed for bound printer. Native download cancelled."),
                { type: "danger" }
            );
            return true; // FAIL-CLOSED: Bound printer failed, do not bypass to browser PDF
        }
    } catch (err) {
        console.warn("[print_gateway] Silent dispatch error:", err);
        notification.add(
            _t("Gateway print dispatch error: %s", err?.message || err),
            { type: "danger" }
        );
        return true; // FAIL-CLOSED: Dispatch call failed, cancel native PDF dialog
    }

    return false; // Fallback to standard Odoo report action only when no binding exists
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
