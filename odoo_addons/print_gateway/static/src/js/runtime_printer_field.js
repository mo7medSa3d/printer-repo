/** @odoo-module */

import { Component, onWillStart, onWillUpdateProps, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

function relationalId(value) {
    if (!value) return false;
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value[0] || false;
    if (typeof value === "object") return value.resId || value.id || false;
    return false;
}

export class RuntimeAgentField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_agent">
            <select class="o_input" t-att-disabled="props.readonly || state.loading || !state.branchId" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading agents…' : (!state.branchId ? 'Select an Odoo Branch first' : 'Select Gateway Runtime Agent')"/></option>
                <option t-foreach="state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === props.record.data[props.name]">
                    <t t-esc="agent.name"/> — <t t-esc="agent.id"/> — <t t-esc="agent.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway agent discovery failed.</small>
        </div>`;

    setup() {
        this.rpc = useService("rpc");
        this.state = useState({ loading: false, agents: [], branchId: false, error: null });
        onWillStart(() => this.load(this.props));
        onWillUpdateProps((nextProps) => {
            const before = this.scope(this.props);
            const after = this.scope(nextProps);
            if (before.companyId !== after.companyId || before.branchId !== after.branchId) {
                this.load(nextProps);
            }
        });
    }

    scope(props) {
        return {
            companyId: relationalId(props.record?.data?.company_id),
            branchId: relationalId(props.record?.data?.branch_id),
        };
    }

    async load(props) {
        const { companyId, branchId } = this.scope(props);
        this.state.branchId = branchId;
        this.state.agents = [];
        this.state.error = null;
        if (!companyId || !branchId) {
            this.state.loading = false;
            return;
        }
        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-agents", { company_id: companyId, branch_id: branchId });
            this.state.agents = Array.isArray(result?.agents) ? result.agents : [];
        } catch (error) {
            this.state.error = error;
        } finally {
            this.state.loading = false;
        }
    }

    onChange(event) {
        this.props.record.update({
            [this.props.name]: event.target.value || false,
            printer_id: false,
        });
    }
}

export class RuntimePrinterField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_printer">
            <select class="o_input" t-att-disabled="props.readonly || state.loading || !state.agentId" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading printers…' : (!state.agentId ? 'Select Gateway Runtime Agent first' : 'Select Gateway Runtime Printer')"/></option>
                <option t-foreach="state.printers" t-as="printer" t-key="printer.id" t-att-value="printer.id" t-att-selected="printer.id === props.record.data[props.name]">
                    <t t-esc="printer.name"/> — <t t-esc="printer.id"/> — <t t-esc="printer.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway printer discovery failed.</small>
        </div>`;

    setup() {
        this.rpc = useService("rpc");
        this.state = useState({ loading: false, printers: [], agentId: false, error: null });
        onWillStart(() => this.load(this.props));
        onWillUpdateProps((nextProps) => {
            const before = this.scope(this.props);
            const after = this.scope(nextProps);
            if (before.companyId !== after.companyId || before.branchId !== after.branchId || before.agentId !== after.agentId) {
                this.load(nextProps);
            }
        });
    }

    scope(props) {
        return {
            companyId: relationalId(props.record?.data?.company_id),
            branchId: relationalId(props.record?.data?.branch_id),
            agentId: props.record?.data?.runtime_agent_id || false,
        };
    }

    async load(props) {
        const { companyId, branchId, agentId } = this.scope(props);
        this.state.agentId = agentId;
        this.state.printers = [];
        this.state.error = null;
        if (!companyId || !branchId || !agentId) {
            this.state.loading = false;
            return;
        }
        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-printers", {
                company_id: companyId,
                branch_id: branchId,
                agent_id: agentId,
            });
            this.state.printers = Array.isArray(result?.printers) ? result.printers : [];
        } catch (error) {
            this.state.error = error;
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
