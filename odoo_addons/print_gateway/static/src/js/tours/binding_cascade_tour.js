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
            content: "2. Focus Company input for dynamic autocomplete",
            run: "click",
        },
        {
            trigger: '.ui-autocomplete > li:first-child > a, .o-autocomplete--dropdown-item:first-child, .dropdown-item:first-child',
            content: "Select Company via dynamic autocomplete",
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
            trigger: '.o_field_runtime_agent select',
            content: "Re-select Agent before persisting",
            run: "selectByIndex 1",
        },
        {
            trigger: '.o_field_runtime_printer select:not([disabled]) option:not([value=""])',
            content: "Wait for printers to re-populate",
            run() {},
        },
        {
            trigger: '.o_field_runtime_printer select',
            content: "Re-select Printer for persistence check",
            run: "selectByIndex 1",
        },
        {
            trigger: "button.o_form_button_save",
            content: "Click Save",
            run: "click",
        },
        {
            trigger: ".o_form_saved",
            content: "Wait for .o_form_saved confirmation",
            run() {},
        },
        {
            trigger: ".o_form_view",
            content: "Trigger a record reload or re-read action",
            run() {
                const reloadBtn = document.querySelector(".o_control_panel .o_pager_reload, button.o_form_button_reload, button[aria-label='Reload'], button[title='Reload']");
                if (reloadBtn) {
                    reloadBtn.click();
                } else {
                    const form = document.querySelector(".o_form_view");
                    if (form) {
                        form.dispatchEvent(new CustomEvent("reload", { bubbles: true }));
                    }
                }
            },
        },
        {
            trigger: '.o_field_runtime_printer select',
            content: "Assert that the selected printer_id remains populated from database storage",
            run() {
                const printerSelect = document.querySelector('.o_field_runtime_printer select');
                if (!printerSelect || !printerSelect.value) {
                    throw new Error("Expected printer_id to remain populated from database storage after reload");
                }
            },
        },
    ],
});
