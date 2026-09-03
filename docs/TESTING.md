# Testing

Labels used throughout the documentation:

| Label | Meaning |
|---|---|
| **VERIFIED** | Executed by an automated test in this repository |
| **SOFTWARE VERIFIED** | Executed end-to-end, but only through software components (no hardware) |
| **COMPILE VERIFIED** | Compiles and passes `vet` for the target platform; never executed |
| **SIMULATED** | A development stand-in replaces the real device/subsystem |
| **NOT VERIFIED** | Not exercised at all in this repository |
| **REQUIRES HARDWARE / REQUIRES LIVE ODOO** | Can only be verified outside CI |

## 1. Test suites

### Gateway — Vitest (`tests/`, configs `vitest.config.mts` and `vitest.integration.config.mts`)

| File | Tests | Needs PostgreSQL | Covers |
|---|---:|---|---|
| `job-status.test.ts` | 4 | no | State machine transitions |
| `payload.test.ts` | 7 | no | Shared payload contract (types, base64, 5 MiB cap) |
| `phase1-routing.test.ts` | 3 | no | Binding selection basics |
| `phase1-branch-authorization.test.ts` | 6 | no | Branch scope + document-type authorization |
| `phase2-routing-fallback.test.ts` | 12 | no | Priority fallback, capability matrix |
| `odoo-simulation.test.ts` | 4 | no | Odoo-side payload/contract simulation |
| `regression-critical.test.ts` | 35 | no | Contract/source-level regressions |
| `ws-claim-delivery.test.ts` | 13 | **yes** | Claim-before-delivery, ACK, requeue/lease recovery, duplicate push, concurrent claimers/polls, terminal jobs |
| `odoo-sync-transaction.test.ts` | 16 | **yes** | Transactional sync, rollback, branch isolation, idempotency and dependency validation |
| `routing-availability.test.ts` | 9 | **yes** | Printer availability, disabled/offline semantics, fallback and document authorization |
| `e2e-job-flow.test.ts` | 3 | **yes** | Odoo → gateway → WebSocket agent → status, capability mismatch, queued recovery |
| `print-idempotency.test.ts` | 8 | **yes** | Idempotency and concurrent retry safety |
| `auth-rate-limit.test.ts` | 13 | **yes** | Login throttling, cooldown, IP/account separation and concurrent attempts |
| `health.test.ts` | 2 | **yes** | Health endpoint security/DB behavior |
| `heartbeat-enabled.test.ts` | 2 | **yes** | Heartbeat lifecycle protections |
| `agent-registration.test.ts` | 4 | **yes** | Pairing-code registration, branch derivation and rate limiting |
| `architecture-pg.test.ts` | 3 | **yes** | Canonical ownership/lifecycle schema invariants |
| `odoo-addon-static.test.ts` | 8 | no | Odoo addon source-level and contract regressions |
| `printer-virtual.test.ts` | 49 | no | Virtual/redirected/physical/unknown classification |
| `routing-virtual-regression.test.ts` | 7 | no | Virtual printers never win routing |
| `desktop-ui-smoke.test.ts` | 1 | no | Desktop pages boot; virtual queues hidden |

The CI workflow runs both the unit suite and the PostgreSQL-backed integration suite. `vitest.config.mts` and `vitest.integration.config.mts` are native ESM TypeScript configs, avoiding Vite's CommonJS/ESM config-loader warning.

### Agent — Go (`agent/internal/**/*_test.go`)

88 test functions in 8 packages:

| Package | Focus |
|---|---|
| `internal/agent` | Per-printer serialization, dispatch dedup/bounding/shutdown, TTL, retry, WebSocket envelope parsing + `job_ack`, duplicate delivery, terminal-result replay, `CAPABILITY_MISMATCH` reporting, crash recovery + `reprint_after_crash` policy |
| `internal/printer` | PDF validation/temp-file lifecycle/injection safety/backend matrix, RAW + ESC/POS transports, IPP request building, discovery classification, hardening |
| `internal/payload` | Strict payload parsing |
| `internal/queue` | SQLite idempotency, status updates, interrupted-job marking |
| `internal/config` | Config load/validate/paths |
| `internal/storage` | Secret store permissions |
| `internal/integration` | Mock TCP printer E2E, failure and crash scenarios |
| `internal/diag` | Diagnostics helpers |

Hardware-dependent Go tests are guarded by `RUN_PHYSICAL_PRINTER_TESTS` and skipped by default.

### Odoo addon — Python

`odoo_addons/print_gateway/tests/test_report_gateway.py` and `test_security_regressions.py` require an Odoo test runner (`odoo -i print_gateway --test-enable`) — **REQUIRES LIVE ODOO**.

### Desktop (Tauri)

The Windows workflow verifies the Tauri frontend, builds the Go agent, packages MSI + NSIS installers, verifies artifact existence, installs the MSI, and runs a smoke test on the installed application.
