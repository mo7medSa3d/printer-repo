/** @odoo-module **/

import { registry } from "@web/core/registry";

registry.category("web_tour.tours").add("binding_cascade_tour", {
    url: "/odoo",
    steps: () => [
        {
            trigger: '.o_app[data-menu-xmlid="print_gateway.menu_print_gateway_root"], a[data-menu-xmlid="print_gateway.menu_print_gateway_root"]',
            content: "1. Open print_gateway.binding form view (via apps menu)",
            run: "click",
        },
        {
            trigger: 'a[data-menu-xmlid="print_gateway.menu_print_gateway_binding"]',
            content: "Navigate to Hardware Print Bindings",
            run: "click",
        },
        {
            trigger: "button.o_list_button_add",
            content: "Create a new print_gateway.binding record",
            run: "click",
        },
        {
            trigger: '.o_field_widget[name="company_id"] input',
            content: "2. Select Company",
            run: "edit San Francisco",
        },
        {
            trigger: '.o_field_widget[name="company_id"] .dropdown-item:first',
            content: "Confirm selected Company",
            run: "click",
        },
        {
            trigger: '.o_field_widget[name="branch_id"]',
            content: "3. Verify branch_id can be left empty without validation blocks",
            run() {
                const branchField = document.querySelector('.o_field_widget[name="branch_id"]');
                const branchInput = branchField ? branchField.querySelector("input") : null;
                if (branchInput && (branchInput.hasAttribute("required") || branchInput.getAttribute("aria-required") === "true")) {
                    throw new Error("branch_id should not be marked as required");
                }
            },
        },
        {
            trigger: '.o_field_runtime_agent select:not([disabled])',
            content: "4. Select Agent -> assert printers dropdown populates",
            run: "selectByIndex 1",
        },
        {
            trigger: '.o_field_runtime_printer select:not([disabled]) option:not([value=""])',
            content: "Assert printers dropdown populates",
            run() {},
        },
        {
            trigger: '.o_field_runtime_printer select',
            content: "5. Select Printer",
            run: "selectByIndex 1",
        },
        {
            trigger: '.o_field_runtime_agent select',
            content: "Change Agent -> assert Printer selection resets",
            run: "selectByIndex 0",
        },
        {
            trigger: '.o_field_runtime_printer select',
            content: "Assert Printer selection resets",
            run() {
                const printerSelect = document.querySelector('.o_field_runtime_printer select');
                if (printerSelect && printerSelect.value) {
                    throw new Error("Printer selection should reset when Agent is cleared or changed");
                }
            },
        },
        {
            trigger: "button.o_form_button_save",
            content: "6. Save and re-read",
            run: "click",
        },
    ],
});
