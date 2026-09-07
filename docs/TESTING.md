# Testing and Acceptance Matrix

## Gateway (Vitest)

The Gateway test suite is split into unit tests and PostgreSQL-backed integration tests. Integration tests apply the complete Drizzle migration chain, including the final migration that removes duplicated Odoo business ownership.

Core coverage includes payload validation, routing/capability checks, API-key authentication, rate limiting, health behavior, agent registration, heartbeat, WebSocket claim/delivery, concurrent claim safety, idempotency, runtime lifecycle behavior, multi-instance delivery, migration upgrades, and the final runtime-only schema.

`tests/gateway-runtime-architecture.test.ts` is a repository architecture guard. It fails when Gateway source recreates Gateway branches, branch ownership, duplicated destinations/document types/bindings, or legacy printer compatibility layers.

`tests/architecture-pg.test.ts` proves the final database contains no duplicated Odoo business tables and no branch/local-network/destination foreign-key ownership columns in runtime records.

## Odoo 19

The addon tests cover:

- minimal Gateway configuration
- URL/SSRF validation
- authenticated Test Connection
- API-key connection contract
- deterministic destination resolution
- binding validation and company isolation
- fail-closed report routing
- durable outbox semantics
- Gateway-enabled versus native-disabled printing behavior
- architecture files/models/manifest contract

The GitHub Actions Odoo 19 job installs the addon from a clean database with `--test-tags=/print_gateway`.

## POS

The POS bundle patches `PosStore.printReceipt()` so Gateway-enabled receipt/reprint/Restaurant Print Bill flows go to the server-side central router. The frontend does not invoke the native POS printer when Gateway printing is enabled.

Odoo 19 `printChanges()` is a separate kitchen/order-preparation path. Because this integration does not define a Gateway binding/transport for that path, it is explicitly fail-closed when Gateway mode is enabled rather than falling through to native/browser printing. Native `printChanges()` is used only when Gateway mode is disabled.

## Agent

Go tests cover runtime queue semantics, per-printer serialization, WebSocket delivery/ACK, retry and crash recovery, payload parsing, printer backends, configuration, secure storage, diagnostics, and integration scenarios. Race tests are required in CI.

## Mandatory acceptance cases

The acceptance suite must demonstrate:

1. valid Gateway URL and SSRF policy
2. API-key generation/hash/revocation
3. authenticated Test Connection
4. binding creation and invalid/cross-company rejection
5. Sales, Invoice, Delivery, Purchase, POS receipt/reprint/bill, and custom report routing
6. Gateway unavailable/auth failure/timeout/submission failure
7. durable retry and unknown physical outcome
8. global idempotency and duplicate-print prevention
9. zero browser/native printing while Gateway mode is enabled
10. native Odoo printing only when Gateway mode is explicitly disabled
11. no Odoo Gateway-branch creation or branch synchronization API
12. no Odoo agent/printer provisioning models
13. no duplicated Gateway business entity lifecycle

## Not yet verifiable in this repository

A physical Windows printer and a live production/staging Odoo + Gateway deployment are environment-dependent. CI can compile and test the software components, but a final production approval still requires a real staging print: Odoo -> Router -> Gateway -> Agent -> physical printer, with evidence that the printer executes exactly once.
