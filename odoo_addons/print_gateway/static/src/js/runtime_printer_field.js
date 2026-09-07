/** @odoo-module */

import { Component, onWillStart, onWillUpdateProps, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class RuntimeAgentField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_agent">
            <select class="o_input" t-att-disabled="props.readonly || state.loading" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading agents…' : 'Select runtime agent'"/></option>
                <option t-foreach="state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === props.record.data[props.name]">
                    <t t-esc="agent.name"/> — <t t-esc="agent.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway agent discovery failed.</small>
        </div>`;

    setup() {
        this.rpc = useService("rpc");
        this.state = useState({ loading: true, agents: [], error: null });
        onWillStart(() => this.load());
        onWillUpdateProps((nextProps) => {
            if (nextProps.record?.data?.company_id !== this.props.record?.data?.company_id) {
                this.load();
            }
        });
    }

    async load() {
        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-agents", {});
            this.state.agents = Array.isArray(result?.agents) ? result.agents : [];
            this.state.error = null;
        } catch (error) {
            this.state.error = error;
            this.state.agents = [];
        } finally {
            this.state.loading = false;
        }
    }

    onChange(event) {
        this.props.record.update({ [this.props.name]: event.target.value || false });
    }
}

export class RuntimePrinterField extends Component {
    static props = ["*"];
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
        this.rpc = useService("rpc");
        this.state = useState({ loading: true, printers: [], error: null });
        onWillStart(() => this.load());
        onWillUpdateProps((nextProps) => {
            if (
                nextProps.record?.data?.company_id !== this.props.record?.data?.company_id ||
                nextProps.record?.data?.runtime_agent_id !== this.props.record?.data?.runtime_agent_id
            ) {
                this.load();
            }
        });
    }

    async load() {
        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-printers", {});
            this.state.printers = Array.isArray(result?.printers) ? result.printers : [];
            this.state.error = null;
        } catch (error) {
            this.state.error = error;
            this.state.printers = [];
        } finally {
            this.state.loading = false;
        }
    }

    onChange(event) {
        this.props.record.update({ [this.props.name]: event.target.value || false });
    }
}

registry.category("fields").add("gateway_runtime_agent", RuntimeAgentField);
registry.category("fields").add("gateway_runtime_printer", RuntimePrinterField);
