/** @odoo-module */

import { Component, onWillStart, onWillUpdateProps, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

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
            <t t-if="props.readonly">
                <span t-esc="props.record.data[props.name] || ''"/>
            </t>
            <t t-else="">
                <select class="o_input" aria-label="Gateway Runtime Agent" t-att-disabled="state.loading || !state.companyId" t-att-aria-invalid="state.error ? 'true' : undefined" t-att-aria-describedby="state.error ? 'o_pg_agent_error' : undefined" t-on-change="onChange">
                    <option value=""><t t-esc="state.loading ? 'Loading agents…' : (!state.companyId ? 'Select an Odoo Company first' : 'Select Gateway Runtime Agent')"/></option>
                    <option t-foreach="state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === props.record.data[props.name]">
                        <t t-esc="agent.name"/> — <t t-esc="agent.id"/> — <t t-esc="agent.status"/>
                    </option>
                    <option t-if="!state.loading &amp;&amp; !state.error &amp;&amp; state.companyId &amp;&amp; !state.agents.length" value="" disabled="disabled">No active agents found — pair one from Gateway Configuration</option>
                </select>
                <div t-if="state.error" class="mt-1 d-flex align-items-center gap-2">
                    <small id="o_pg_agent_error" class="text-danger">Gateway agent discovery failed. Check the Gateway connection, then retry.</small>
                    <button type="button" class="btn btn-link btn-sm p-0" t-on-click="retryLoad">Retry</button>
                </div>
            </t>
        </div>`;

    setup() {
        this.rpc = rpc;
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
        });
    }

    retryLoad() {
        this.load(this.props);
    }
}

if (!registry.category("fields").contains("gateway_runtime_agent")) {
    // The widget is bound exclusively to print_gateway.binding.runtime_agent_id,
    // an opaque Gateway runtime identifier stored as Char (see models/binding.py).
    // Declaring ["char"] keeps the descriptor truthful so Odoo 19 does not log
    // a misleading "don't support the type" warning on every form open.
    registry.category("fields").add("gateway_runtime_agent", {
        component: RuntimeAgentField,
        supportedTypes: ["char"],
    });
}
