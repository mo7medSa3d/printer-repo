/** @odoo-module **/

import { Component, onWillStart, onWillUpdateProps, useState, xml } from "@odoo/owl";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

function companyId(value) {
    if (!value) {
        return false;
    }
    if (Array.isArray(value)) {
        return value[0];
    }
    if (typeof value === "object") {
        return value.id;
    }
    return value;
}

export class RuntimePrinterField extends Component {
    static props = { ...standardFieldProps };
    static template = xml`
        <div class="o_field_widget o_field_runtime_printer">
            <select class="o_input" t-att-disabled="props.readonly || state.loading" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading printers…' : 'Select a runtime printer'"/></option>
                <option t-foreach="state.printers" t-as="printer" t-key="printer.id" t-att-value="printer.id" t-att-selected="printer.id === props.record.data[props.name]">
                    <t t-esc="printer.name"/> — <t t-esc="printer.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway printer discovery failed.</small>
        </div>`;

    setup() {
        this.state = useState({ loading: true, printers: [], error: null });
        onWillStart(() => this.load());
        onWillUpdateProps((nextProps) => {
            if (companyId(nextProps.record?.data?.company_id) !== companyId(this.props.record?.data?.company_id)) {
                this.load();
            }
        });
    }

    async load() {
        this.state.loading = true;
        try {
            const result = await rpc("/print_gateway/runtime-printers", {});
            this.state.printers = Array.isArray(result?.printers) ? result.printers : [];
            this.state.error = null;
        } catch (error) {
            this.state.error = error;
            this.state.printers = [];
        } finally {
            this.state.loading = false;
        }
    }

    async onChange(event) {
        await this.props.record.update({ [this.props.name]: event.target.value || false });
    }
}

export const runtimePrinterField = {
    component: RuntimePrinterField,
    supportedTypes: ["char"],
};

registry.category("fields").add("gateway_runtime_printer", runtimePrinterField);
