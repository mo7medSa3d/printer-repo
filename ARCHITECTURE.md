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

The addon does not create or synchronize Branches, Gateway Branches, agents, printers,
destinations, or document-type catalogs.

## Odoo integration layer

The addon contains only:

- `print_gateway.gateway_config`: URL, API key, enable flag, test status.
- `print_gateway.binding`: existing Odoo company/context + existing report + runtime printer reference.
- `print_gateway.print_job`: durable logical print operation and retry/unknown state.
- `print_gateway.print_router`: the single authoritative routing entry point.
- `ir.actions.report.report_action`: backend interception for report-driven print actions.
- A targeted POS controller override for Odoo 19 direct `/pos/sale_details_report` PDF output.
- POS `PosStore.printReceipt`: receipt/reprint/Restaurant Bill interception.

Native Odoo printing is allowed only while the Gateway is explicitly disabled. Gateway-enabled errors are fail-closed.

## Routing model

A binding is configured against native Odoo records. No duplicate destination/document entities are created.
The destination reference is derived from the real Odoo context:

- `pos.order` -> its existing `pos.config`.
- `stock.picking` -> its existing `stock.picking.type`.
- Report-driven printing -> the actual `ir.actions.report`.

The document type is derived from the actual report/model and is stored for deterministic matching.
Runtime printer choices are read from the Gateway's authenticated runtime-printer endpoint; Odoo does not provision printers.

## Backend report paths

Standard backend buttons in Sales, Invoices, Inventory/Delivery, Purchase, and custom report actions normally enter through
`ir.actions.report.report_action()`. With Gateway enabled, the addon resolves the Odoo binding, renders the payload,
persists a durable outbox operation, submits it to `POST /api/print/jobs`, and returns a client notification rather than a browser PDF.

Low-level `_render_qweb_pdf()` is deliberately not globally intercepted because that method is also used for non-print concerns
such as report generation for other services. Known direct user-facing print endpoints are intercepted at their controller boundary.

Odoo 19 POS also exposes `/pos/sale_details_report`, which directly renders a PDF. This repository overrides that specific route so
Gateway-enabled requests become router jobs instead of PDF/browser output.

## POS receipt paths

Odoo 19 `PosStore.printReceipt()` passes `basic_receipt` to the `OrderReceipt` component and enables `webPrintFallback` in its print options.
The addon patches `printReceipt()` so Gateway-enabled receipt printing never reaches the native POS printer service.
Unsynced orders are synchronised first because the Gateway router requires an existing Odoo `pos.order` record.

This covers the common receipt entry paths that converge on `printReceipt()`, including Full Receipt, Simplified Receipt rendering intent,
reprint, automatic receipt printing, and Restaurant Print Bill. Exact visual parity of Simplified Receipt is a staging acceptance item because
Odoo renders that option in the frontend `OrderReceipt` component; the addon must not claim parity without browser verification.

## POS preparation / kitchen printing

Odoo 19 preparation printing is a separate path: `sendOrderInPreparation()` calls `printChanges()`, which renders
`OrderChangeReceipt` and invokes the POS printer service independently of `printReceipt()`.

The addon therefore intercepts `printChanges()` when Gateway printing is enabled and fails closed with an explicit error.
It does not silently invoke the native kitchen printer or browser printing. Kitchen/order-preparation printing is consequently
an explicit unsupported Gateway path until a dedicated Gateway kitchen payload/binding contract is implemented and staged.

## Gateway API

Odoo sends only the runtime execution target and business context needed for the job:

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

No Gateway branch identifier, destination entity ID, or document-type entity is sent.

## API key lifecycle

The Gateway manager supports generation, one-time display/copy, and revoke. Only a cryptographic hash remains at rest.
Odoo stores the credential it must use to connect to the Gateway. Keys are installation-scoped and authenticated with the configured Odoo database name.

## Reliability

The Odoo outbox is committed before the network request. Retries reuse the same idempotency key. A timeout or transport interruption becomes
`unknown` rather than a definitive physical failure. Gateway idempotency makes safe retries converge on one logical print job.

## Security

- Company-scoped Odoo configuration and ACLs.
- No API key or complete print payload in logs.
- HTTP/HTTPS-only Gateway URLs with credential/query/fragment restrictions and SSRF controls.
- Authenticated Odoo Gateway endpoints.
- Runtime queue and rate limits remain Gateway responsibilities.
- No browser/native fallback when Gateway printing is enabled.

## Explicit support boundary

The implementation claims Gateway routing only for print paths that are actually intercepted. POS preparation/kitchen printing is currently
intercepted and fail-closed, but not claimed as Gateway-routed until its dedicated payload contract is implemented and validated.
