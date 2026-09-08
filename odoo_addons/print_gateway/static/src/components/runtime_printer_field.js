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

export class RuntimePrinterField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_printer">
            <select class="o_input" t-att-disabled="props.readonly || state.loading || !state.agentId" t-on-change="onChange">
                <option value=""><t t-esc="state.loading ? 'Loading printers…' : (!state.agentId ? 'Select Gateway Runtime Agent first' : 'Select Gateway Runtime Printer')"/></option>
                <option t-foreach="filteredPrinters" t-as="printer" t-key="printer.id" t-att-value="printer.id" t-att-selected="printer.id === props.record.data[props.name]">
                    <t t-esc="printer.name"/> [<t t-esc="printer.deviceClass || 'generic'"/>] — <t t-esc="printer.status"/>
                </option>
            </select>
            <small t-if="state.error" class="text-danger">Gateway printer discovery failed.</small>
        </div>`;

    setup() {
        this.rpc = useService("rpc");
        this.currentRequestId = 0;
        this.state = useState({ loading: false, printers: [], agentId: false, destinationType: false, error: null });
        onWillStart(() => this.load(this.props));
        onWillUpdateProps((nextProps) => {
            const before = this.scope(this.props);
            const after = this.scope(nextProps);
            if (before.companyId !== after.companyId || before.branchId !== after.branchId || before.agentId !== after.agentId || before.destinationType !== after.destinationType) {
                if (before.agentId !== after.agentId) {
                    this.state.printers = [];
                }
                this.load(nextProps);
            }
        });
    }

    get filteredPrinters() {
        const dest = this.state.destinationType;
        if (!dest || !Array.isArray(this.state.printers)) {
            return this.state.printers;
        }
        if (dest === "pos" || dest === "pos_printer") {
            const thermal = this.state.printers.filter(p => !["laser", "inkjet"].includes((p.deviceClass || "").toLowerCase()));
            return thermal.length ? thermal : this.state.printers;
        }
        if (dest === "picking_type") {
            const labels = this.state.printers.filter(p => ["label", "thermal", "unknown"].includes((p.deviceClass || "").toLowerCase()));
            return labels.length ? labels : this.state.printers;
        }
        return this.state.printers;
    }

    scope(props) {
        return {
            companyId: relationalId(props.record?.data?.company_id),
            branchId: relationalId(props.record?.data?.branch_id),
            agentId: props.record?.data?.runtime_agent_id || false,
            destinationType: props.record?.data?.destination_type || false,
        };
    }

    async load(props) {
        const reqId = ++this.currentRequestId;
        this.state.printers = [];
        this.state.error = null;

        const { companyId, branchId, agentId, destinationType } = this.scope(props);
        this.state.agentId = agentId;
        this.state.destinationType = destinationType;

        if (!companyId || !agentId) {
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
            if (reqId !== this.currentRequestId) return;
            this.state.printers = Array.isArray(result?.printers) ? result.printers : [];
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
        this.props.record.update({ [this.props.name]: event.target.value || false });
    }
}

if (!registry.category("fields").contains("gateway_runtime_printer")) {
    registry.category("fields").add("gateway_runtime_printer", RuntimePrinterField);
}
