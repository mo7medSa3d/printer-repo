# Final Production Blocker Remediation Audit

Repository: `mo7medSa3d/printer-repo`

Verified GitHub baseline: `51b577218f6341a25723f24fa1b22ac751bc1e2a`

Local deliverable commit: `e71e6f18827c0eaeebcfdf39b6d0fb2043b63af4`

This local commit is the complete corrected repository snapshot produced for this audit. It is based on the verified GitHub `main` baseline above. The local snapshot is not claimed to be pushed to GitHub by this report.

## Executive summary

The remaining production blockers were re-verified against the current repository state rather than inherited from an older audit. The implementation now preserves the intended hierarchy:

`Odoo business configuration -> Branch -> Agent -> Printer -> Physical Device`

Odoo remains the business/configuration authority; Gateway remains the runtime authority. Gateway Printer ownership is exclusively `Printer -> Agent -> Branch`; there is no independent Gateway printer branch ownership field.

The principal P0 blockers were addressed as follows:

- Odoo logical print operations now have a persisted idempotency key and a durable post-commit outbox/retry boundary. New manual operations create new keys; retries reuse the persisted key.
- Agent job status transitions now use atomic compare-and-set updates on the expected prior status and agent scope.
- Routing requires an active, online, fresh Agent using one centralized availability policy (`STALE_AGENT_THRESHOLD_SECONDS`, default 90 seconds).
- Odoo document-type synchronization now carries canonical `payloadHint`, and Gateway validates `raw|escpos|pdf`.
- PCL support was explicitly removed rather than left partially implemented. Migrations fail closed if existing PCL configuration is found.
- PostgreSQL integration testing is a real CI gate with migration execution before integration tests.
- Exact document-type bindings outrank generic bindings, then priority, then ID as a deterministic tie-breaker.
- Minimal production observability was added with structured event logs already present in the runtime plus a manager-authenticated Prometheus-style `/api/metrics` endpoint for process-local counters.
- Migration safety was strengthened to refuse ambiguous legacy state instead of rewriting it silently.

The repository is **not declared generally production-ready from this workspace** because real PostgreSQL, Odoo runtime, Windows installer execution, and physical-printer E2E could not all be executed locally. Those limitations are explicitly listed below.

## Dependency map

```text
Odoo
  ├─ Branch/configuration models
  ├─ Document Types + payloadHint
  ├─ Bindings
  └─ Print Operation outbox
          │ post-commit / retry cron
          ▼
Gateway (Next.js + Drizzle)
  ├─ authentication / authorization
  ├─ Branch -> Agent -> Printer runtime ownership
  ├─ deterministic routing + Agent availability
  ├─ job state machine / idempotency
  └─ PostgreSQL runtime state
          │ WebSocket / HTTP
          ▼
Go Agent
  ├─ registration / heartbeat
  ├─ printer discovery
  ├─ queue + delivery
  └─ physical transport implementations
          │
          ▼
Physical device / Windows spooler / network printer
```

## Issue matrix

| Issue | Status | Evidence | Tests | Remaining Risk |
|---|---|---|---|---|
| P0 Odoo logical-operation idempotency | FIXED | `odoo_addons/print_gateway/models/ir_actions_report.py`, `models/branch.py`, `models/print_job.py`; persisted `idempotency_key`, post-commit submission, retry cron | `tests/odoo-addon-static.test.ts`; Odoo `test_retry_with_same_idempotency_key_returns_same_job`, `test_different_idempotency_key_creates_new_job`; new `test_report_operation_is_durable_and_deferred_until_commit` | Real Odoo runtime/restart/crash-window execution not run locally |
| P0 concurrent Agent job status race | FIXED | `src/app/api/agent/jobs/route.ts`; compare-and-set on `id + agent + branch + expected status` | `tests/job-status-postgres-concurrency.test.ts` incl. concurrent SQL and concurrent HTTP PATCH | Requires real PostgreSQL run to execute integration test |
| P0 stale/offline Agent routing | FIXED | `src/lib/agent-availability.ts`, `src/lib/routing.ts`, `test-connection/route.ts`; single 90s policy | `tests/routing-availability.test.ts` | Threshold is runtime-configurable and must be aligned with deployment heartbeat cadence |
| P0 payloadHint sync drift | FIXED | `odoo_addons/print_gateway/models/branch.py` serializer + `src/app/api/odoo/sync/route.ts` validation/storage | `tests/odoo-addon-static.test.ts`, `tests/odoo-sync-transaction.test.ts` | Live Odoo/Gateway sync not executed locally |
| P0 PCL contract inconsistency | FIXED | Odoo model removes PCL; Gateway accepts no PCL; `drizzle/0008_remove_pcl_contract.sql`, `odoo_addons/.../pre-migrate.py` fail closed | `tests/odoo-addon-static.test.ts`, architecture guards | Existing deployments containing PCL must be remediated before upgrade |
| P1 real PostgreSQL CI | FIXED | `.github/workflows/ci.yml`; PostgreSQL 16 service, migrations, unit/integration split | CI configuration/static validation; local PostgreSQL execution unavailable | CI itself should be observed after push |
| P1 exact-vs-generic routing precedence | FIXED | `src/lib/routing.ts`; exact match before priority/id | `tests/routing-availability.test.ts`, `tests/phase1-routing.test.ts` | Live DB ordering behavior not run locally |
| Live Odoo/Gateway/Agent/PostgreSQL E2E | NOT RUN | Environment-dependent harness/documentation present | Odoo/Gateway integration test suites exist | Requires live external stack |
| Windows physical E2E | NOT RUN | `.github/workflows/build-windows.yml`, `scripts/smoke-test-windows.ps1`, `WINDOWS_PHYSICAL_E2E.md` | Windows build/smoke is CI-defined, not executed here | Requires Windows runner + printer infrastructure; physical output is not verified |
| Production observability | PARTIALLY FIXED | `src/lib/log.ts`, runtime event logging, `src/lib/metrics.ts`, `/api/metrics` | Static/security tests plus route compilation by source review; full runtime scrape not run | Counters are process-local; use external log/metrics aggregation for multi-instance deployment |
| Migration safety | FIXED | `0001`, `0006`, `0008`, `0009`, Odoo pre-migration | Static migration review and syntax validation | Existing applied migrations cannot be retroactively changed; execute documented remediation before deployment |

## Detailed implementation

### 1. Odoo idempotency / outbox

The logical operation boundary is the Odoo `print_gateway.print_job` record. A fresh manual print creates one new row and one new key. Retries operate on that persisted row and key.

`ir_actions_report.py` now creates the new operation key once for the new report invocation and calls `branch.create_print_job(..., defer_until_commit=True)`.

When deferred, `branch.py` persists the row in the current Odoo transaction and registers an Odoo post-commit callback using an independent cursor. This avoids manually committing the caller's business transaction. If the process dies before submission, the queued row remains for `cron_retry_pending_print_jobs`, which calls `action_submit_pending()` using the original key.

Odoo's own documentation states that manual commits inside normal RPC/business transactions are unsafe and recommends them only when a separately created cursor is explicitly used; the post-commit/independent-cursor design follows that constraint. See Odoo 19 coding guidance: https://www.odoo.com/documentation/19.0/contributing/development/coding_guidelines.html

The complete payload is retained as JSON rather than `str(payload)[:2000]`, because truncating a persisted payload would make durable retry impossible for larger print documents.

Gateway uniqueness remains `unique(branch_id, idempotency_key)` and therefore preserves branch isolation.

### 2. Atomic Agent job transitions

`src/app/api/agent/jobs/route.ts` now updates a job only if the database row still has the observed status and still belongs to the authenticated Agent/Branch. Exactly one writer can therefore win a conflicting transition.

Terminal states `success`, `failed`, and `expired` remain terminal.

The integration regression suite contains actual concurrent database sessions, plus two concurrent HTTP PATCH calls against the route.

### 3. Agent availability

`src/lib/agent-availability.ts` centralizes the policy:

- lifecycle must be `active`
- runtime status must be `online`
- `lastSeenAt` must exist
- heartbeat age must be <= the configured stale threshold

Default threshold: 90 seconds.

Routing skips unavailable Agents and can continue to the next deterministic binding candidate. The `test-connection` route now uses the same policy rather than maintaining a second 2-minute definition.

### 4. Payload semantics

Canonical document payload semantics are `pdf`, `raw`, and `escpos`. `payloadHint` is validated at the Gateway sync boundary. PDF payloads continue to require a `%PDF-` signature and are never silently treated as RAW/ESC/POS.

### 5. PCL decision

PCL was removed end-to-end because the repository had no complete runtime PCL implementation. No migration rewrites PCL records. Existing PCL configuration blocks upgrade with an explicit list/error path, requiring administrator remediation.

PCL driver names appearing inside Windows printer capability fixtures are descriptive hardware metadata and are not runtime PCL protocol support.

### 6. Routing precedence

The canonical order is:

1. exact `documentType` match
2. lower `priority`
3. lower `binding.id`

Thus an exact match always outranks a generic binding, even if the generic binding has a numerically better priority. This is deterministic and explicitly tested.

### 7. Database invariants

Gateway schema now encodes the following important invariants:

- Agent requires Branch.
- Printer requires Agent.
- Printer has no independent Branch field.
- Printer lifecycle and Agent lifecycle use `active|disabled|retired` checks.
- `retired` is terminal at application lifecycle boundaries.
- Print jobs retain their Branch/Agent/Printer references as historical routing identity.
- Odoo and Gateway use branch-scoped idempotency uniqueness.
- Document-type payload hints are constrained to the canonical set.

### 8. Migration safety

`drizzle/0001_phase1_branch_foundation.sql` no longer creates or assigns a synthetic default branch during branch backfill. Missing branch ownership now blocks migration.

`drizzle/0006_architecture_hardening.sql` now checks for contradictory legacy `config.protocol` versus canonical `protocol` before removing the legacy nested key.

`drizzle/0008_remove_pcl_contract.sql` and `drizzle/0009_runtime_invariant_guard.sql` refuse unsupported/ambiguous state rather than rewriting it.

The Odoo pre-migration hook similarly blocks existing PCL data and requires explicit remediation.

### 9. Observability and sensitive logging

The existing structured logger redacts sensitive values. No new log path writes document payload bytes, API secrets, pairing codes, or session/JWT values.

New process-local counters include the major print/job/routing event families, with manager-authenticated Prometheus output at `GET /api/metrics`.

For multi-instance production deployment, these counters should be scraped per process and aggregated externally; the structured log stream remains the more durable event source.

## Files changed / added for this remediation

Compared with the pre-refactor repository snapshot, the remediation touched 39 paths including:

- `.github/workflows/ci.yml`
- `package.json`, `package-lock.json`
- `drizzle/0001_phase1_branch_foundation.sql`
- `drizzle/0006_architecture_hardening.sql`
- `drizzle/0008_remove_pcl_contract.sql`
- `drizzle/0009_runtime_invariant_guard.sql`
- `src/db/schema.ts`
- `src/lib/routing.ts`
- `src/lib/agent-availability.ts`
- `src/lib/metrics.ts`
- `src/app/api/agent/jobs/route.ts`
- `src/app/api/agent/heartbeat/route.ts`
- `src/app/api/odoo/sync/route.ts`
- `src/app/api/print/jobs/route.ts`
- `src/app/api/printers/[id]/test-connection/route.ts`
- `src/app/api/metrics/route.ts`
- `odoo_addons/print_gateway/models/branch.py`
- `odoo_addons/print_gateway/models/print_job.py`
- `odoo_addons/print_gateway/models/ir_actions_report.py`
- `odoo_addons/print_gateway/models/document_type.py`
- `odoo_addons/print_gateway/models/printer.py`
- `odoo_addons/print_gateway/migrations/1.1.0/pre-migrate.py`
- `odoo_addons/print_gateway/data/cron.xml`
- routing/idempotency/concurrency regression tests
- architecture/API/ODOO/printing/test documentation

## API changes

Canonical printer input uses one writable representation per concept:

- `printerType`: `physical|virtual|redirected`
- `deviceClass`: `thermal|laser|inkjet|label|other|unknown`
- `connectionType`: `network|usb|spooler|ipp|ipps`
- `protocol`: `raw|escpos|ipp|ipps|spooler`

Compatibility parsing is restricted to input normalization; canonical responses do not deliberately duplicate aliases.

`POST /api/print/jobs` continues to use branch-scoped idempotency and routing through Branch/Destination/Document Type rather than client-selected physical ownership.

New endpoint: `GET /api/metrics` is manager-authenticated and returns text Prometheus counters.

## Odoo changes

Odoo topology remains:

`Branch -> Agent -> Printer`

Odoo Printer `branch_id` remains a stored related field to `agent_id.branch_id`, never an independently authoritative relationship.

Print report actions now use a durable local operation/outbox record and post-commit submission. Pending operations are retried by scheduled action without generating a new idempotency key.

Document Type sync includes `payloadHint`.

## Go Agent changes

No new Agent protocol source of truth was introduced for this blocker set. The existing Go Agent remains the runtime printer/transport layer, while Gateway determines ownership/routing and Odoo supplies configuration.

Go validation is present in CI (`go vet`, normal tests, race tests), but Go dependencies could not be fetched in the current offline workspace, so those commands are classified as ENVIRONMENT BLOCKED here.

## CI changes

`.github/workflows/ci.yml` contains:

- PostgreSQL 16 service
- deterministic credentials/database
- `DATABASE_URL`
- migrations before integration tests
- unit and integration test separation
- lint
- typecheck
- build
- Go test
- Go race test
- Go vet

`.github/workflows/build-windows.yml` contains Windows build, installer artifact verification, MSI installation, and application smoke-test steps.

## Test coverage added/updated

### Odoo

- same logical operation reuses one key
- new operation gets a new key
- timeout retry uses the same key
- durable full payload persistence
- post-commit registration boundary
- `payloadHint` sync
- PCL rejection/remediation
- branch-derived printer ownership

### PostgreSQL/Gateway

- atomic conflicting status transitions
- actual concurrent HTTP PATCH race
- terminal job protection
- active/online/fresh Agent availability
- offline Agent rejection
- stale Agent rejection
- exact document-type precedence
- idempotent concurrent duplicate jobs
- branch isolation
- lifecycle/history preservation

## Commands executed and exact outcomes

### Executed successfully

`python -m compileall -q odoo_addons/print_gateway`

Result: PASS.

`python -m py_compile` over the Odoo models/tests/migration files.

Result: PASS.

YAML parse of `.github/workflows/ci.yml` and `.github/workflows/build-windows.yml`.

Result: PASS.

JSON parse of `package.json` and `src-tauri/tauri.conf.json`.

Result: PASS.

Global Gateway ownership guard for `printer.branchId`, `printer.branch_id`, and `printers.branch_id` under `src/`.

Result: PASS — no authoritative Gateway printer branch ownership references.

Runtime PCL source guard over Gateway/Odoo runtime contracts.

Result: PASS — no runtime PCL protocol/payload choice remains; only migration guards and descriptive printer-driver fixture strings remain.

Obvious secret-pattern scan.

Result: PASS — no obvious hardcoded credential/token patterns were found.

`gofmt` validation of Go sources.

Result: PASS.

`tsc --noEmit` final invocation.

Result: ENVIRONMENT BLOCKED. The previously observed two implicit-any errors in `tests/printer-virtual.test.ts` were fixed; the remaining output is dominated by missing npm dependency/type packages because `node_modules` is unavailable.

### Environment-blocked

`npm ci --ignore-scripts --offline`

Result: BLOCKED because the local npm cache lacks `zod-validation-error-4.0.2.tgz`. No network package download was possible.

`npm run lint`

Result: BLOCKED because `eslint` is not installed without dependencies.

`npm test`

Result: BLOCKED because `vitest` is not installed without dependencies.

`go test ./...`

Result: BLOCKED because required Go modules (`gorilla/websocket`, `yaml.v3`, `kardianos/service`, `go-sqlite3`) could not be downloaded from `proxy.golang.org` in the offline workspace.

`go vet ./...`

Result: same dependency/network limitation; not claimed passed.

Real PostgreSQL migration/integration execution locally.

Result: NOT RUN — no PostgreSQL service/container available in the current workspace.

Odoo runtime tests.

Result: NOT RUN — no Odoo server/runtime environment available.

Windows installer build/smoke.

Result: NOT RUN locally — PowerShell/Windows runtime unavailable.

Physical printer output validation.

Result: NOT RUN — no physical printer or Windows spooler test environment available.

## Backward compatibility

Compatibility is preserved only at explicit input boundaries where it does not weaken the canonical model.

Legacy printer `type` and `config.protocol` can be normalized at the input boundary into canonical fields, with conflicting dual values rejected.

Legacy Gateway printer branch ownership is intentionally removed rather than left writable.

PCL is not compatibility-retained because partial support would create distributed contract drift; existing PCL configuration must be remediated explicitly before migration.

## Remaining risks

1. Real PostgreSQL-backed integration has to execute once against the CI service to verify migrations and concurrent paths in the actual runner.
2. Odoo post-commit/retry behavior requires an actual Odoo runtime execution, including process restart and retry-cron scenarios.
3. Windows installer and real device transport remain environment-dependent. The repository provides CI/build/smoke paths, but this workspace did not execute them.
4. `/api/metrics` is process-local. Multi-instance deployments need external scraping/aggregation; do not treat the in-memory counter as durable telemetry storage.
5. Existing production databases that already ran older migrations need a controlled migration window and explicit remediation for any inconsistent ownership/PCL state.

## Deployment / migration order

1. Back up PostgreSQL and Odoo databases.
2. Preflight existing Gateway/Odoo data for missing Agent branches, orphan printers, cross-branch bindings, duplicate IDs, and PCL records.
3. Remediate blocked records explicitly; do not assign a synthetic default branch and do not delete history.
4. Deploy the new Gateway migration set and run migrations before serving traffic.
5. Deploy the Odoo add-on update and let the Odoo pre-migration guard validate unsupported state.
6. Verify Odoo Branch -> Agent -> Printer synchronization.
7. Verify one manual print creates one persisted logical operation and that a retry uses the same key.
8. Run PostgreSQL integration suite in CI against the migration result.
9. Run live Odoo/Gateway/Agent E2E.
10. Run Windows installer and printer validation in a real environment before production traffic.

## External validation commands

### Node / Gateway

```bash
npm ci
npm run db:migrate
npm run typecheck
npm run lint
npm run test:unit
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/print_gateway_test' npm run test:integration
npm run build
```

### Go Agent

```bash
cd agent
go vet ./...
go test -count=1 ./...
go test -count=1 -race ./...
```

### Odoo

Run the module's Odoo test suite in an actual supported Odoo runtime, including:

- `test_report_gateway.py`
- `test_routing_correctness.py`
- `test_security_regressions.py`

and perform a process restart followed by the pending-print cron to validate durable retry semantics.

### Windows

Run `.github/workflows/build-windows.yml` and `scripts/smoke-test-windows.ps1` on Windows 10/11. Then execute the physical-printer matrix documented in `WINDOWS_PHYSICAL_E2E.md`.

## Second independent review

A separate final pass focused on the failure classes most likely to survive a superficial refactor:

- hidden branch/default fallback: no operational default/first-record branch selection remains;
- contradictory printer ownership: Gateway Printer branch is derived only through Agent;
- lifecycle bypasses: retired Agent/Printer remains terminal;
- cross-branch authorization: routing and Odoo binding checks remain fail-closed;
- stale Agent routing: availability is centralized and applied before selection;
- nondeterministic routing: exact-document precedence, priority, then ID;
- PDF/RAW ambiguity: payload signature/capability validation is retained;
- migration data loss: PCL/legacy conflicts block rather than rewrite blindly;
- CI false positives: PostgreSQL integration has an actual service and migration gate;
- misleading health state: existing dashboard health/error handling remains explicit;
- unbounded auth rate-limit retention: prior retention migration and tests remain in place;
- sync semantics: HTTP/non-JSON/non-success conditions fail instead of becoming false success;
- sensitive logging: new metrics/logging never carries document payloads or secrets.

## Final production-readiness rating

**PARTIALLY VERIFIED / NOT YET PRODUCTION-READY FROM THIS WORKSPACE.**

The requested production blockers are implemented with regression coverage and CI gates, but final production acceptance still requires actual execution against:

- PostgreSQL
- Odoo
- Windows 10/11
- a real network/spooler/USB printer environment

No unavailable external environment has been represented as passed.
