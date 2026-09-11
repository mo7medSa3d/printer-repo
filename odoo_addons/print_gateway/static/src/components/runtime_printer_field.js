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

export class RuntimePrinterField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_printer">
            <t t-if="props.readonly">
                <span t-esc="props.record.data[props.name] || ''"/>
            </t>
            <t t-else="">
                <select class="o_input" aria-label="Gateway Runtime Printer" t-att-disabled="state.loading || !state.agentId" t-att-aria-invalid="state.error ? 'true' : undefined" t-att-aria-describedby="state.error ? 'o_pg_printer_error' : undefined" t-on-change="onChange">
                    <option value=""><t t-esc="state.loading ? 'Loading printers…' : (!state.agentId ? 'Select Gateway Runtime Agent first' : 'Select Gateway Runtime Printer')"/></option>
                    <option t-foreach="filteredPrinters" t-as="printer" t-key="printer.id" t-att-value="printer.id" t-att-selected="printer.id === props.record.data[props.name]">
                        <t t-esc="printer.name"/> [<t t-esc="printer.deviceClass || 'generic'"/>] — <t t-esc="printer.status"/>
                    </option>
                    <option t-if="!state.loading &amp;&amp; !state.error &amp;&amp; state.agentId &amp;&amp; !filteredPrinters.length" value="" disabled="disabled">No printers reported by this agent — check the agent PC</option>
                </select>
                <div t-if="state.error" class="mt-1 d-flex align-items-center gap-2">
                    <small id="o_pg_printer_error" class="text-danger">Gateway printer discovery failed. Check the agent connection, then retry.</small>
                    <button type="button" class="btn btn-link btn-sm p-0" t-on-click="retryLoad">Retry</button>
                </div>
            </t>
        </div>`;

    setup() {
        this.rpc = rpc;
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
            const labels = this.state.printers.filter(p => ["label", "thermal", "unknown", "other", "barcode"].includes((p.deviceClass || "").toLowerCase()));
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

    retryLoad() {
        this.load(this.props);
    }
}

if (!registry.category("fields").contains("gateway_runtime_printer")) {
    // The widget is bound exclusively to print_gateway.binding.printer_id,
    // an opaque Gateway runtime identifier stored as Char (see models/binding.py).
    // Declaring ["char"] keeps the descriptor truthful so Odoo 19 does not log
    // a misleading "don't support the type" warning on every form open.
    registry.category("fields").add("gateway_runtime_printer", {
        component: RuntimePrinterField,
        supportedTypes: ["char"],
    });
}
