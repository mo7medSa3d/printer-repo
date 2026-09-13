# FINAL_TEST_RESULTS.md (Phase 12 — PASS only for what actually ran)

## Executed here (PASS)
- `go vet ./...` (agent): PASS
- `gofmt -l agent`: PASS (clean)
- `go test ./...` (agent, all packages incl. race suites): PASS
- `go test -race` (agent, printer, queue, storage): PASS
- `GOOS=windows go build/vet`: PASS (compile-level only)
- `node --experimental-strip-types --check`: PASS on every edited/new pure-`.ts`/`.mjs` file (SYNTAX ONLY — not typecheck; `.tsx` unsupported by the checker, verified as a tool limitation against untouched files)
- `python3 -m py_compile`: PASS on edited Odoo files (SYNTAX ONLY)
- drizzle journal↔SQL mapping: PASS (33/33 1:1)
- `.env`/compose/Caddyfile diff review: PASS (static)

## NOT VERIFIED (environment-blocked, honest gates)
- TS typecheck (`tsc`), ESLint, vitest unit/integration, `next build`: BLOCKED — no `node_modules`, installs forbidden, host Node 22 vs required ≥24 + engine-strict
- New tests `canonicalize-order`, `dashboard-payload-projection`, repaired suites (`agent-deletion`, `discovery-approval`, `batch-status`, `job-maintenance`, `legacy-print-authorization`, `runtime-constraints`, `architecture-pg`, `ws-claim-delivery`, `migration-upgrade`, `ci-tripwire`): NOT VERIFIED — require Postgres + full install; CI must run
- Odoo suite incl. new `test_04b2`: NOT VERIFIED — no Odoo runtime here (`py_compile` only)
- Migration 0032 apply/rollback: BLOCKED — no psql/dockerd (SQL reviewed; DO-block abort path is fail-loud by construction)
- `cargo check`/clippy/tauri build: BLOCKED — crates.io fetch forbidden + webkit sysdeps absent
- npm/OSV/govulncheck advisory scans: BLOCKED — registry bulk endpoint + api.osv.dev unreachable from sandbox
- Windows service/tray/physical-printer E2E, live Odoo browser E2E: NOT VERIFIED by design (hardware gates)
- server.ts graceful-shutdown behavior, placeholder-refusal boot path: NOT VERIFIED at runtime (code-reviewed only)
- Multi-instance claim/notify behavior, WS reconnect storms: NOT VERIFIED here (covered by repo suites in CI)

## Repaired-but-unrunnable suites (documented residual risk)
Pre-existing tenant drift repaired in: agent-deletion (+13 sites), discovery-approval, batch-status, job-maintenance, legacy-print-authorization, runtime-constraints, architecture-pg, ws-claim-delivery, migration-upgrade (+0032 entry), ci-tripwire, pg-concurrent-claim.mjs. If any repaired assertion mis-models current code, CI will show it — that is precisely why P1-01 requires a CI run on this tree before any release claim.
