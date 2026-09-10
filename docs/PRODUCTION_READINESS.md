# Production Readiness

## Verdict

**FAIL / NOT PRODUCTION-READY** until every software, Odoo 19, Windows Agent, and physical-printer staging gate is executed and green.

## Architecture gate

Required topology:

`Odoo -> Gateway URL + API Key -> central Print Router -> Gateway -> Agent -> Physical Printer`

The Odoo addon must contain only Gateway configuration, native Odoo print bindings, durable print outbox, report interception, and POS interception.

The addon must not create or mirror branches, agents, printers, destinations, or document types.

## Software gates

- Node typecheck
- lint
- complete unit tests
- PostgreSQL integration tests
- production-like migration/upgrade tests
- Gateway build
- Go vet/tests/race tests

## Odoo 19 gates

- install `print_gateway` on Odoo 19
- upgrade from an existing addon installation
- execute backend report print paths for Sales, Invoices, Delivery/Inventory, Purchase, and custom reports
- verify Gateway-enabled reports never invoke native/browser fallback
- verify explicit Gateway-disabled mode still uses native Odoo printing

## POS gates

- normal POS receipt print
- POS reprint
- Restaurant Print Bill
- Gateway-enabled POS never opens browser print preview/dialog
- Gateway failure surfaces an error and never falls back to native POS printing

## Reliability gates

- durable outbox survives transaction/process failure
- retry reuses the same idempotency key
- duplicate submit returns the same Gateway job
- transport timeout is represented as unknown physical outcome
- runtime status reconciliation resolves unknown outcomes

Exactly-once physical printing is not claimed. A device can accept bytes immediately before a network/process failure.

## Security gates

- API key raw secret appears only at creation
- list/read endpoints never expose raw secrets
- revoke immediately invalidates a key
- Odoo Gateway authentication is based on the Odoo installation API key
- Gateway URL validation blocks credentials, query/fragment, and unauthorized private targets
- no secret/payload logging
- Odoo company ACL and record-rule isolation
- Gateway runtime authentication and rate limits remain active

## Environment-dependent release gates

1. Real PostgreSQL execution of all database integration tests.
2. Real Odoo 19 module installation/upgrade and Python tests.
3. Windows Agent installation and service/tray verification.
4. Live Odoo -> Gateway -> Agent -> physical printer staging.
5. Representative PDF, RAW and ESC/POS printer execution.
6. Deliberate Gateway outage/auth failure/printer-unavailable tests.
7. CI results observed after the final branch commit.

This document must remain FAIL until those gates have evidence from the actual environment.
