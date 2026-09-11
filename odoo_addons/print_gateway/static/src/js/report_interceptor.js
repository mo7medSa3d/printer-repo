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
    if (action.type !== "ir.actions.report" || action.report_type !== "qweb-pdf") {
        return false;
    }

    const orm = env.services.orm;
    const notification = env.services.notification;
    const resIds =
        action.context?.active_ids ||
        (action.context?.active_id ? [action.context.active_id] : []) ||
        action.res_ids ||
        action.docids ||
        [];

    try {
        const res = await orm.call(
            "print_gateway.binding",
            "dispatch_report_action",
            [],
            {
                report_name: action.report_name,
                res_ids: resIds,
                context: action.context || {},
            }
        );

        if (res && res.has_binding && (res.success === false || !res.dispatched)) {
            notification.add(
                res.error || _t("Gateway print failed for bound printer. Native download cancelled."),
                { type: "danger" }
            );
            return true; // FAIL-CLOSED: Bound printer failed, do not bypass to browser PDF
        }

        if (res && (res.dispatched || res.success)) {
            // The interceptor must never greenlight an UNKNOWN outcome: the
            // dispatch call succeeded but the physical result is ambiguous.
            // Both toasts link to Print Jobs so the interception never
            // leaves the user without a next step.
            const openJobs = {
                name: _t("Open Print Jobs"),
                primary: true,
                onClick: () => env.services.action.doAction("print_gateway.action_print_gateway_jobs"),
            };
            if (["unknown", "partial"].includes(res.status)) {
                notification.add(
                    _t("Print outcome unknown - the printer may have received part or all of this report. Verify at the printer before reprinting (Print Jobs > Force Reprint)."),
                    { type: "warning", sticky: true, buttons: [openJobs] }
                );
            } else {
                notification.add(
                    res.message || _t("Report queued on Gateway printer: %s - watch the Print Jobs list for the final result.", res.printer_name || "Printer"),
                    { type: "success", buttons: [openJobs] }
                );
            }
            return true; // Cancel default browser PDF dialog
        }
    } catch (err) {
        notification.add(
            _t("Gateway print dispatch error: %s", err?.message || err),
            { type: "danger" }
        );
        return true; // FAIL-CLOSED: Dispatch call failed, cancel native PDF dialog
    }

    return false; // Fallback to standard Odoo report action only when no binding exists
}

registry.category("ir.actions.report handlers").add("silent_gateway_handler", silentPrintReportHandler, { sequence: 5 });
