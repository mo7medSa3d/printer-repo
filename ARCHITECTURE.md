# Print Gateway Architecture

## Final topology

```text
Odoo 19
  │
  │ Gateway URL + installation API key
  ▼
Central Print Router (Odoo addon)
  │
  │ Binding + payload + durable outbox
  ▼
Gateway (Next.js + PostgreSQL)
  │
  ▼
Windows Agent (Go)
  │
  ▼
Physical Printer
```

## Ownership

| Concern | Owner |
|---|---|
| Existing Odoo companies / branches | Odoo |
| Business documents and report definitions | Odoo |
| POS configurations / operation types | Odoo |
| Existing business destination/context | Odoo |
| Print intent | Odoo |
| Print bindings | Odoo Print Gateway addon |
| Gateway URL / installation credential | Odoo Print Gateway addon |
| Durable Odoo print outbox | Odoo Print Gateway addon |
| Agents, pairing, heartbeats | Gateway |
| Runtime printers and capabilities | Gateway / Agent |
| Queueing, claiming, delivery, runtime state | Gateway |
| Physical execution | Agent |

The addon does not create or synchronize Gateway-side branches, destinations, document-type catalogs, agents, or printers.

## Odoo integration layer

The addon contains only:

- `print_gateway.gateway_config`: Gateway URL, API key, enable flag, test status.
- `print_gateway.binding`: native Odoo company/context + native destination/report + runtime printer reference.
- `print_gateway.print_job`: durable logical print operation and retry/unknown state.
- `print_gateway.print_router`: the single authoritative routing entry point.
- `ir.actions.report.report_action`: backend interception for report-driven print actions.
- A targeted POS controller override for Odoo 19 direct `/pos/sale_details_report` output.
- POS `PosStore.printReceipt`: receipt/reprint/Restaurant Bill interception.
- POS preparation printing interception through the same server-side router and binding model.

Native Odoo printing is allowed only while the Gateway is explicitly disabled. Gateway-enabled errors are fail-closed.

## Authoritative routing context

The Print Gateway router never chooses a business company from arbitrary document state. For Gateway-enabled routing, the active Odoo company (`env.company`) is authoritative.

A supplied company must equal the active company, and a printable record with `company_id` must belong to that same active company. Odoo's multi-company access rules still determine whether the caller may read the record; the Print Gateway layer additionally rejects stale or mismatched company context.

The canonical route is:

```text
Current Company (`env.company`)
        +
Native Odoo destination (POS / operation type / report / kitchen printer)
        +
Document type derived from the actual report/model
        +
Selected runtime printer binding
        ↓
One resolved Print Gateway binding
        ↓
Durable Odoo print operation
        ↓
Gateway runtime job
        ↓
Agent
        ↓
Physical printer
```

In this repository, a branch is represented by Odoo's native company hierarchy. The Gateway does not maintain a parallel branch model.

## Routing model

A binding is configured against native Odoo records. No duplicate Gateway business entities are created.
The destination reference is derived from the real Odoo context:

- `pos.order` → its existing `pos.config`.
- `stock.picking` → its existing `stock.picking.type`.
- Report-driven printing → the actual `ir.actions.report`.
- POS preparation/kitchen printing → the existing Odoo `pos.printer`.

The document type is derived from the actual report/model and stored for deterministic matching. Runtime printer choices are read from the Gateway's authenticated runtime-printer endpoint; Odoo does not provision printers.

## Backend report paths

Standard backend buttons in Sales, Invoices, Inventory/Delivery, Purchase, and custom report actions normally enter through `ir.actions.report.report_action()`. With Gateway enabled, the router validates the active company and document company, resolves the binding, renders the payload, persists a durable outbox operation, submits it to `POST /api/print/jobs`, and returns a client notification rather than a browser PDF.

Low-level `_render_qweb_pdf()` is deliberately not globally intercepted because that method is also used for non-print concerns such as report generation for other services. Known direct user-facing print endpoints are intercepted at their controller boundary.

Odoo 19 POS also exposes `/pos/sale_details_report`, which directly renders a PDF. This repository overrides that specific route so Gateway-enabled requests become router jobs instead of PDF/browser output.

## POS receipt paths

Odoo 19 `PosStore.printReceipt()` is patched so Gateway-enabled receipt/reprint/Restaurant Bill flows never reach the native POS printer service. Unsynced orders are synchronized first because the Gateway router requires a persisted `pos.order`.

The server then validates that the POS order belongs to `env.company` and resolves exactly one Odoo binding before submitting the runtime job.

## POS preparation / kitchen printing

Odoo 19 preparation printing is a separate path from receipt printing. The addon intercepts the preparation output, renders `OrderChangeReceipt` as a JPEG, and sends it through `route_kitchen_print()`.

The Odoo `pos.printer` remains the business destination. The binding maps that native destination plus the `kitchen` document type to a Gateway runtime printer. The server validates that the POS order, native kitchen printer, and active Odoo company agree before creating the durable operation. The client-generated operation identifier is reused for retries of the same preparation receipt, while physical delivery remains at-least-once.

## Gateway boundary

Odoo sends only the runtime execution target and the business context needed by the runtime queue:

```json
{
  "printerId": "runtime-printer-id",
  "documentType": "receipt",
  "destination": "Main POS",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "..."
  },
  "idempotencyKey": "stable-for-this-logical-operation"
}
```

No Gateway branch identifier, destination entity ID, or document-type entity is accepted by the current API contract. Runtime ownership is Gateway-side (`Agent → Printer`); business ownership remains Odoo-side.

## API key lifecycle

The Gateway manager supports generation, one-time display/copy, and revoke. Only a cryptographic hash remains at rest.
Odoo stores the credential it must use to connect to the Gateway. Keys are installation-scoped. Odoo Gateway authentication is based on the Odoo installation API key. The Odoo database name is not used as an authentication requirement.

## Reliability

The Odoo outbox is committed before the network request. Retries reuse the same idempotency key. A timeout or transport interruption becomes `unknown` rather than a definitive physical failure.

Odoo-side idempotency is protected by a database uniqueness constraint and handles concurrent create races by reconciling the committed winner. Gateway-side idempotency is protected by the PostgreSQL uniqueness constraint and transaction lock before queue insertion.

Gateway delivery uses an atomic claim (`FOR UPDATE SKIP LOCKED`) that mints a fresh claim token per attempt; agents echo the token on every status report, so a stale attempt can never finalize a reclaimed job. WebSocket push is used when available, polling is the recovery path. Only claims with no delivery evidence are ever re-queued; a claim that was delivered but went silent becomes terminal-failed with an unknown-outcome marker - never auto-requeued, never auto-retried. A queued print job contains the runtime printer and agent identifiers needed for later delivery; it does not depend on mutable `env.company` or client-side state after creation.

## Security

- Company-scoped Odoo configuration and ACLs.
- Odoo Print Gateway routing requires the active company and rejects document/company mismatches.
- Company-specific native destinations use Odoo `check_company` validation plus explicit server-side constraints.
- No API key or complete print payload is written to logs.
- HTTP/HTTPS-only Gateway URLs with credential/query/fragment restrictions and SSRF controls.
- Authenticated Odoo Gateway endpoints.
- Runtime queue and rate limits remain Gateway responsibilities.
- No browser/native fallback when Gateway printing is enabled.
- Agent WebSocket delivery is authenticated, bounded, and recoverable through polling.

## Validation boundary

The Gateway validates runtime printer lifecycle/status, capability compatibility, payload shape, expiration and idempotency. It does not reconstruct Odoo business routing decisions.

The Odoo layer validates company context, native destination ownership, document type, binding selection, and durable operation identity before submission.
