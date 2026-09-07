# Print Gateway Architecture

## Final topology

```text
Odoo 19
  │
  │ Gateway URL + installation API key
  │
  ▼
Print Gateway addon
  │
  │ central Print Router
  │ durable Odoo print outbox
  │ Destination + Document Type -> Printer binding
  ▼
Gateway (Next.js + PostgreSQL)
  │
  │ runtime execution, queue, claim, delivery
  ▼
Windows Agent (Go)
  │
  │ local printer transport
  ▼
Physical Printer
```

## Ownership

| Concern | Owner |
|---|---|
| Native Odoo companies/branches | Odoo |
| Business documents and report definitions | Odoo |
| POS configurations / operation types | Odoo |
| Print destinations and document context | Odoo |
| Print bindings | Odoo Print Gateway addon |
| Gateway URL and API key | Odoo Print Gateway addon |
| Durable Odoo print outbox | Odoo Print Gateway addon |
| Agents, pairing, heartbeats | Gateway |
| Runtime printers and capabilities | Gateway / Agent |
| Gateway queue, claiming, delivery, runtime status | Gateway |
| Physical printing | Agent |

The addon does not create, synchronize, or mirror branches, agents, printers,
destinations, or document types.

## Odoo integration layer

The Odoo addon contains only:

- `print_gateway.gateway_config`: Gateway URL, installation API key, enable flag, connection test status.
- `print_gateway.binding`: native Odoo destination/context + document type -> Gateway printer id.
- `print_gateway.print_job`: durable logical print operation and retry state.
- `print_gateway.print_router`: the single routing entry point.
- `ir.actions.report.report_action`: backend report interception that delegates to the central router.
- POS `PosStore.printReceipt`: frontend interception for receipt printing, reprint, and Restaurant bill printing.

Native Odoo printing is used only when Gateway printing is explicitly disabled.
When Gateway printing is enabled, Gateway errors are surfaced and native printing is never attempted.

## Central router

`print_gateway.print_router` resolves:

1. The active Odoo company.
2. The document type (explicit context or known model mapping).
3. The native Odoo destination/context (POS, operation type, report, or company).
4. The highest-priority enabled binding.
5. A durable outbox row with a fresh idempotency key for the logical print action.
6. Post-commit submission to the Gateway.

A multi-record report is rejected when its records resolve to different bindings.

## POS path

Odoo 19 receipt printing, POS reprinting, and Restaurant "Print Bill" calls converge on
`PosStore.printReceipt()`. The addon patches this method and calls the server-side
`pos.order.action_print_gateway_receipt()` handler.

```text
POS Print / Reprint / Print Bill
  -> PosStore.printReceipt()
  -> pos.order.action_print_gateway_receipt()
  -> print_gateway.print_router.route_pos_receipt()
  -> Print Binding
  -> Odoo durable print_job
  -> Gateway POST /api/print/jobs
  -> Agent
  -> physical printer
```

The patched POS path does not call the original POS printer implementation when Gateway
printing is enabled. Therefore browser print dialogs, report navigation, `window.print()`,
and native fallback are outside the Gateway-enabled path.

## Gateway API contract

The Odoo print API is intentionally small:

```json
{
  "printerId": "printer_xxx",
  "documentType": "receipt",
  "destination": "POS / Main Counter",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "..."
  },
  "idempotencyKey": "..."
}
```

The request contains no Gateway branch identifier and no Gateway business-routing object.
Gateway resolves the owning Agent/Printer from runtime ownership.

## API keys

The manager console exposes a minimal API-key lifecycle:

- Generate API Key.
- Display raw key once.
- Copy it.
- Never display the raw key again.
- Revoke the key.

The database stores only the SHA-256 hash used for authentication. The key is bound to the configured
Odoo database name through the `X-Odoo-Database` header.

## Reliability

The Odoo outbox creates one durable logical operation before the Gateway HTTP request.
Transport retries reuse the same `idempotencyKey`. A timeout is recorded as an unknown physical outcome;
status reconciliation can later establish the Gateway result. Gateway-side idempotency prevents a retry
from becoming a second physical print.

## Security boundaries

- Odoo configuration is company-scoped and write-protected to system administrators.
- API keys are never logged or returned by list endpoints.
- Gateway URLs reject credentials, query/fragment data, and non-HTTP schemes.
- Local/private targets require explicit deployment allow-listing.
- Gateway-enabled failures are fail-closed; there is no silent browser/native fallback.
- Gateway remains responsible for agent/printer authentication, runtime authorization, queue limits,
  rate limiting, and physical execution safety.

## Explicit non-goals

The addon is not a second ERP. It does not manage companies, branches, agents, physical printers,
Gateway discovery, Gateway runtime inventory, or duplicated business catalogs.
