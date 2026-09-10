# Print Gateway Architecture

## Target architecture

```text
Odoo business action
  -> Central Odoo Print Router
  -> Odoo durable outbox
  -> Gateway URL + installation API key
  -> Gateway runtime queue
  -> Agent
  -> Physical Printer
```

Odoo is the source of truth for business documents, the native company/branch hierarchy, business print context, deterministic destinations, document/report context, and print bindings. Gateway is the source of truth for runtime agents, heartbeats, runtime printers, queueing, delivery, and execution state.

## Ownership boundary

Odoo owns:

- existing companies and branches
- sales, invoices, inventory, purchase, POS and other business records
- native Odoo destination/context records
- document/report context
- `print_gateway.binding`
- durable print intent/outbox

Gateway owns:

- agents
- pairing and agent credentials
- heartbeats and online state
- runtime printer discovery/configuration
- runtime printer lifecycle
- runtime queue and delivery claims
- runtime job state

The Gateway does not store or create Odoo branches, destinations, document catalogs, or print bindings. The Odoo addon does not create or synchronize Gateway agents or printers.

## Odoo addon models

Only these models remain:

1. `print_gateway.gateway_config` — enabled flag, Gateway origin, installation API key, connection-test state.
2. `print_gateway.binding` — deterministic Odoo destination reference + document type -> Gateway runtime printer ID, with enabled/priority.
3. `print_gateway.print_job` — durable Odoo print intent, idempotency key, remote job ID and reconciliation state.

There is no `print_gateway.branch` model, Gateway Branch ID, branch synchronization, duplicate destination/document-type model, report-mapping model, async/bridge compatibility model, or runtime agent/printer model in Odoo.

## Deterministic routing

For Gateway-enabled printing, the central router must resolve both a document type and a deterministic destination from an existing Odoo record. Supported destination rules are explicit:

- `pos.order` -> its `pos.config`
- `stock.picking` -> its `stock.picking.type`
- other report-driven flows -> the exact `ir.actions.report` record

There is no fallback to company-as-destination and no arbitrary report-name heuristic. Unsupported/ambiguous destinations fail closed.

Bindings are looked up by Odoo company, exact destination reference and normalized document type, ordered by ascending priority then stable ID. Missing or cross-company bindings are errors.

## Report printing

When Gateway printing is disabled, Odoo's native report action remains available. When Gateway printing is enabled, `ir.actions.report.report_action()` routes through the central Print Router, renders a PDF payload, persists the durable outbox row, and submits to the Gateway. A Gateway error is returned to the caller; native report printing is never used as a fallback.

## POS printing

Receipt, reprint and Restaurant Print Bill paths use the Odoo POS router and never call the native POS printer when Gateway mode is enabled. POS order-preparation/kitchen printing is explicitly fail-closed until an equivalent Gateway binding/transport exists; it cannot silently fall back to browser/native printing.

The browser does not open a PDF, navigate to a report URL, call `window.print()`, or show a browser print dialog for Gateway-enabled receipt actions. It receives a success/error/job notification instead.

## Reliability

Every logical print operation has one stable idempotency key. The Odoo outbox row is committed before the Gateway HTTP call. Transport timeouts produce an `unknown` physical outcome rather than an unsafe retry with a new job identity. Gateway PostgreSQL uniqueness prevents concurrent duplicate logical jobs. Odoo and Gateway reconciliation reuse the same remote job identity.

## Security

Odoo API keys are installation-scoped, randomly generated, shown once, hashed at rest, and revocable. Odoo Gateway authentication is based on the Odoo installation API key. The Odoo database name is not used as an authentication requirement. Gateway URL validation rejects credentials, query/fragment components, non-origin paths and private/local addresses unless an explicit deployment allow-list is configured. Redirects are disabled. Logs do not contain API keys or print payloads.

## Verification gates

Required before production approval:

- Gateway unit/integration tests
- Odoo 19 install/upgrade and module tests
- POS frontend interception tests
- migration upgrade test from the previous schema
- Go agent tests and race tests
- real staging Gateway -> Agent -> physical printer test
- repository-wide search proving legacy branch/sync architecture is absent
