# Odoo Print Gateway

Silent Odoo 19 printing through a Gateway and Windows Agent.

```text
Odoo 19
  -> Gateway URL + API Key
  -> central Print Router
  -> Gateway
  -> Windows Agent
  -> Physical Printer
```

## Ownership

Odoo owns companies/branches, business records, POS configuration, report context, and print intent.
The addon stores only Gateway connection settings, native Odoo print bindings, and a durable print outbox.
Gateway owns agents, heartbeats, runtime printers, queueing, delivery, and execution state.

The addon does not create or synchronize branches, agents, printers, destinations, or document types.

## Odoo configuration

Normal operation requires only Gateway URL, API Key, Test Connection, and Gateway Printing Enabled.

The primary binding is `Destination + Document Type -> Printer`.
The destination is an existing Odoo object such as POS configuration, warehouse operation type, report action, or company context. The printer id is a Gateway runtime identity and is never provisioned by the addon.

## Printing

Backend reports use `print_gateway.print_router` from the `ir.actions.report.report_action()` integration hook.
POS printing uses the Odoo 19 `PosStore.printReceipt()` hook, covering receipt print, POS reprint, and Restaurant Print Bill paths.

When Gateway printing is enabled, printing is silent: no browser print dialog, PDF navigation, `window.print()`, or native fallback is allowed. Failures are surfaced to the user.

When Gateway printing is disabled, the native Odoo print path is preserved.

## Reliability

Each logical print operation creates one durable Odoo outbox row and one idempotency key before external submission. Retries reuse that key. Gateway-side idempotency prevents transport retries from creating a second logical print job.

A transport interruption is represented as an unknown physical outcome until Gateway status reconciliation establishes the result.

## Gateway API key

Managers can generate an Odoo API key, copy the raw value once, and revoke it. Gateway stores only the cryptographic hash and never returns raw secrets from list/read endpoints.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
cd agent && go test ./... && go test -race ./...
```

PostgreSQL, Odoo 19, Windows, and physical-printer E2E are release gates and must only be reported as passing when the real environment has executed them.

See [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md), [INSTALLATION.md](INSTALLATION.md), and [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).
