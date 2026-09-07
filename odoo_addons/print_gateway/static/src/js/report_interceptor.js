/** @odoo-module **/

import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";

/**
 * OWL 3 silent report interceptor.
 * Catches ir.actions.report execution in the web client and silently dispatches
 * through the Print Gateway if a binding exists for the current branch/company context.
 * Returning true tells Odoo the report was completely handled, stopping default
 * PDF download / browser print dialogs.
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
    } catch (err) {
        console.warn("[print_gateway] Silent dispatch failed or bypassed:", err);
    }

    return false; // Fallback to standard Odoo report action
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
