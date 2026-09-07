# Odoo addon — `print_gateway`

The addon is an integration layer for Odoo 19. Odoo remains authoritative for companies, branches, business records, POS configuration, and print intent. Gateway remains authoritative for agents, runtime printers, heartbeats, queueing, and physical execution.

The addon does not create or mirror branches, agents, printers, destinations, or document types.

## Installation

1. Install `odoo_addons/print_gateway`.
2. Open **Print Gateway → Gateway Configuration**.
3. Enter Gateway URL and the installation API key.
4. Run **Test Connection**.
5. Enable Gateway Printing.
6. Create **Print Bindings** using existing Odoo destination/context + document type + Gateway printer id.

## Models

| Model | Responsibility |
|---|---|
| `print_gateway.gateway_config` | Gateway URL, API key, enable flag, connection test state |
| `print_gateway.binding` | Existing Odoo destination/context + document type → Gateway printer |
| `print_gateway.print_job` | Durable outbox, idempotency and runtime status/retry state |
| `print_gateway.print_router` | Single routing/service entry point |
| `ir.actions.report` (inherited) | Backend report interception |
| `pos.order` (inherited) | Server-side POS receipt entry point |

## Gateway configuration

Normal operation requires only Gateway URL, API Key, Test Connection, and Gateway Printing Enabled.

No Gateway Branch ID is required or exposed.

## Bindings

The primary relationship is:

`Destination + Document Type → Printer`

The destination is an existing Odoo object such as a POS configuration, warehouse operation type, report action, or company context. The printer is a Gateway runtime identity; the addon never provisions or manages printers.

## Central router

All backend Gateway-enabled reports pass through `print_gateway.print_router.route_report()` from the `ir.actions.report.report_action()` integration hook.

The router resolves the Odoo company, document type, native destination/context and binding, renders the QWeb PDF, persists the outbox operation, and submits it to Gateway after the Odoo transaction commits.

Sales, invoices, delivery/inventory, purchase, and custom QWeb reports therefore share one backend routing layer.

## POS

Odoo 19 POS printing is handled separately at the frontend boundary. The addon patches `PosStore.printReceipt()`, which is the common point used by receipt printing, POS reprint, and Restaurant Print Bill.

When Gateway printing is enabled, POS calls `pos.order.action_print_gateway_receipt()` and does not invoke the native POS printing path. Gateway failures are surfaced to the cashier and are not converted into browser printing.

## Silent printing

Gateway-enabled printing does not open a browser print dialog, PDF preview, report URL, or `window.print()`. The user receives a print-job notification.

Native Odoo printing is allowed only when Gateway printing is explicitly disabled for that operation.

## Reliability

Every logical print action gets one durable outbox row and one idempotency key before external submission. Transport retries reuse the same key. Gateway-side idempotency prevents retry requests from becoming a second logical job.

A transport interruption is represented as an unknown physical outcome until status reconciliation establishes the result.

## Security

Configuration writes are restricted to Odoo system administrators and company-scoped by record rules. Gateway API keys are field-protected and never logged.

Gateway URLs reject credentials, query/fragment data, unsupported schemes, API paths, and local/private targets unless an explicit deployment allow-list permits them. HTTP clients disable redirects.

## Odoo 19 validation

The addon uses Odoo 19 list/form views and the official POS asset bundle. Release validation still requires the actual Odoo 19 runtime plus Gateway/Agent/printer staging because static inspection cannot prove physical printing behavior.
