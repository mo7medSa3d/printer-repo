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
            <select class="o_input" t-att-disabled="props.readonly || state.loading || !state.companyId" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading agents…' : (!state.companyId ? 'Select an Odoo Company first' : 'Select Gateway Runtime Agent')"/></option>
                <option t-foreach="state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === props.record.data[props.name]">
                    <t t-esc="agent.name"/> — <t t-esc="agent.id"/> — <t t-esc="agent.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway agent discovery failed.</small>
        </div>`;

    setup() {
        this.rpc = useService("rpc");
        this.currentRequestId = 0;
        this.state = useState({ loading: false, agents: [], companyId: false, branchId: false, error: null });
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
        const reqId = ++this.currentRequestId;
        this.state.agents = [];
        this.state.error = null;

        const { companyId, branchId } = this.scope(props);
        this.state.companyId = companyId;
        this.state.branchId = branchId;

        if (!companyId) {
            this.state.loading = false;
            return;
        }

        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-agents", { company_id: companyId, branch_id: branchId });
            if (reqId !== this.currentRequestId) return;
            this.state.agents = Array.isArray(result?.agents) ? result.agents : [];
        } catch (error) {
            if (reqId !== this.currentRequestId) return;
            this.state.error = error;
        } finally {
            if (reqId === this.currentRequestId) {
                this.state.loading = false;
            }
        }
    }

    onChange(event) {
        this.props.record.update({
            [this.props.name]: event.target.value || false,
            printer_id: false,
        });
    }
}

if (!registry.category("fields").contains("gateway_runtime_agent")) {
    registry.category("fields").add("gateway_runtime_agent", RuntimeAgentField);
}
