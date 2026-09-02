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

### Gateway — Vitest (`tests/`, config `vitest.config.ts`)

| File | Tests | Needs PostgreSQL | Covers |
|---|---|---|---|
| `job-status.test.ts` | 4 | no | State machine transitions |
| `payload.test.ts` | 7 | no | Shared payload contract (types, base64, 5 MiB cap) |
| `phase1-routing.test.ts` | 3 | no | Binding selection basics |
| `phase1-branch-authorization.test.ts` | 8 | no | Branch scope + document-type authorization |
| `phase2-routing-fallback.test.ts` | 12 | no | Priority fallback, capability matrix |
| `odoo-simulation.test.ts` | 4 | no | Odoo-side payload/contract simulation |
| `regression-critical.test.ts` | 32 | no | Contract/source-level regressions: job-id generation, claim-before-send ordering, undelivered-claim release, WS envelope/ack, PDF pipeline properties, sync validation-before-transaction, `PRINTER_DISABLED`, document-type normalization, crash-marker presence |
| `ws-claim-delivery.test.ts` | 12 | **yes** | Claim-before-delivery, ack, fast-agent rejection, requeue/lease recovery, duplicate push, concurrent claimers/polls, terminal jobs |
| `odoo-sync-transaction.test.ts` | 16 | **yes** | Valid sync commit, rollback, missing/cross-branch printer and destination, deleted-resource disable, changed destination, disabled remains disabled, cross-branch id collision, branch isolation, idempotency, concurrent syncs |
| `routing-availability.test.ts` | 6 | **yes** | `PRINTER_DISABLED` (409) vs `PRINTER_OFFLINE` (503), disabled→healthy fallback, case-insensitive document-type authorization |
| `e2e-job-flow.test.ts` | 3 | **yes** | Odoo → gateway → real WebSocket agent → status, PDF capability mismatch (422), no-socket job stays queued |
| `print-idempotency.test.ts` | 8 | **yes** | First create, retry, concurrent retries, timeout-after-accept, two intentional prints, different reports/records, same record printed twice |
| `auth-rate-limit.test.ts` | 11 | mixed | Backoff math (no DB); login 429 / cooldown / IP / account / concurrent (DB) |
| `health.test.ts` | 2 | mixed | Unauthenticated `/api/health` exposes no inventory counts |
| `heartbeat-enabled.test.ts` | 2 | **yes** | Heartbeat cannot re-enable a disabled printer or update another agent's printer |
| `odoo-addon-static.test.ts` | 9 | no | Test discovery, fail-closed single-record routing, persist-before-HTTP idempotency, per-branch sync state, **Branch → Agent → Printer ownership in the addon** (printer `agent_id` + readonly related `branch_id`, globally unique gateway ids, binding validated via `printer.agent_id.branch_id`, agents synced before printers, fail-loud 1.1.0 migration) |
| `printer-virtual.test.ts` | 49 | no | Virtual/redirected/physical/unknown classification |
| `routing-virtual-regression.test.ts` | 7 | no | Virtual printers never win routing |
| `desktop-ui-smoke.test.ts` | 1 | no | Desktop pages boot; virtual queues hidden |
| `printer-agent-ownership.test.ts` | 31 | **yes** | Architectural regression suite for `Branch → Agent → Printer`: source invariants (no branch in the printers schema, no printer-branch fallbacks, registration/heartbeat never persist a printer branch), `printer-branch.ts` helper units, and against real PostgreSQL — no `printers.branch_id` column, printer requires an agent, heartbeat inherits the agent's branch, an agent cannot hijack another branch's printer, reassigning an agent moves all of its printers atomically, routing honours the derived branch and returns `CROSS_BRANCH_BINDING`, fallback past a cross-branch binding, `PRINTER_DISABLED` preserved, Odoo printer scope + cross-branch key rejection, sync rejects cross-branch bindings, jobs stamped with the derived branch and keeping it after the agent moves |
| `migration-printer-branch.test.ts` | 6 | **yes** | Migration `0006` on throwaway databases: applies and drops the column while preserving rows; **aborts loudly** naming the printer, both branches and the agent when a printer disagrees with its agent, when a printer has no agent, and when an agent has no branch; idempotent on re-run; `printers.agent_id` stays `NOT NULL` + FK after the drop |

Totals (executed for this documentation pass, against a real PostgreSQL 18.4):
`DATABASE_URL=… npx vitest run` → **232 passed / 1 failed / 0 skipped** across 21 files.

The single failure is `auth-rate-limit.test.ts > successful login after cooldown recovers
the account` (429 instead of 401). It is **pre-existing and unrelated** to printer
ownership: it reproduces on unmodified `main` against a clean database.

The database-backed suites are skipped (not failed) when `DATABASE_URL` is unset, because
`FOR UPDATE SKIP LOCKED`, real transactions and concurrent connections cannot be simulated.

```bash
npm test                                                                # DB suites skipped
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test   # full suite
```

`tests/helpers/pg.ts` applies `drizzle/*.sql` itself and truncates all tables between
tests, so any disposable PostgreSQL works. It records applied files in a
`__test_migrations` ledger so each migration runs **exactly once, in order** — without
that, replaying `0001` would re-create the `printers.branch_id` column that `0006` drops.
After migrating it asserts both that the delivery-tracking columns exist **and** that
`printers.branch_id` does not.
`tests/pg-concurrent-claim.mjs` (+ `scripts/pg-concurrent-claim.sh`) is a standalone
concurrency harness against a seeded database.

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

```bash
cd agent
go build ./... && go vet ./... && go test ./... && go test -race ./...
GOOS=windows GOARCH=amd64 go build ./... && GOOS=windows go vet ./...   # cross-build gate
```

Hardware-dependent Go tests are guarded by `RUN_PHYSICAL_PRINTER_TESTS` and skipped by
default.

### Odoo addon — Python

`odoo_addons/print_gateway/tests/test_report_gateway.py` and `test_security_regressions.py`
require an Odoo test runner (`odoo -i print_gateway --test-enable`) — **REQUIRES LIVE ODOO**.
In this repository only syntax and XML validation are executed:

```bash
python -m py_compile odoo_addons/print_gateway/models/*.py odoo_addons/print_gateway/tests/*.py
python -c "import glob,xml.dom.minidom;[xml.dom.minidom.parse(f) for f in glob.glob('odoo_addons/**/*.xml',recursive=True)]"
```

### Desktop (Tauri)

`npm run desktop:vite:build` builds the WebView bundle on any platform. The Rust build,
MSI/NSIS packaging, MSI install and the installed-app smoke test
(`scripts/smoke-test-windows.ps1`) run in the Windows CI workflow — **REQUIRES WINDOWS**;
they were not executed on this Linux workspace (no Rust/cargo toolchain here).

## 2. Full verification battery

```bash
npm run typecheck
npm run lint
npm test                       # add DATABASE_URL to include the DB-backed suites
npm run build
cd agent && go build ./... && go vet ./... && go test ./... && go test -race ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
python -m py_compile odoo_addons/print_gateway/models/*.py
git diff --check
```

The Windows workflow (`.github/workflows/build-windows.yml`) runs typecheck, lint, vitest,
`go vet`, `go test -count=1 -p 2`, `go test -race`, the Go builds, the Tauri MSI+NSIS build,
an actual MSI installation and a smoke test of the installed application.

## 3. What is *not* covered by automated tests

| Area | Status |
|---|---|
| Physical printing on any transport (spooler, USB, RAW TCP, IPP) | **NOT VERIFIED — REQUIRES HARDWARE** |
| Windows PDF submission via `ShellExecuteExW printto` | **COMPILE VERIFIED** only |
| Windows spooler `winspool.drv` calls, USB `CreateFile`, `EnumPrintersW`/`SetupDi` discovery | **COMPILE VERIFIED** only |
| Odoo end-to-end inside a live Odoo instance | **REQUIRES LIVE ODOO** |
| Tauri desktop app on Windows (install, tray, pairing, service control) | **REQUIRES WINDOWS** (covered by CI, not by this workspace) |
| mDNS / SNMP / WSD discovery | **NOT IMPLEMENTED** (log-only stubs) |

The manual procedure that closes the hardware gap is
[../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md). Do not mark it as completed
without filling in its result table from a real run.
