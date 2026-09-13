# FINAL_FINDINGS_LEDGER.md — full defect records (Phase 10 format)

## F-P1-01 · Tenant-isolation patch uncommitted; in-place edit of released migration 0029
- Severity: P1 · Category: DevOps/process · Confidence: HIGH
- Location: git worktree (45 modified + 16 untracked at audit start), `drizzle/0029_enforce_tenant_id_not_null.sql`, `drizzle/meta/_journal.json`, `drizzle/0030_*.sql`, `drizzle/0031_*.sql`
- Observed: the entire Phase-2 tenant isolation body of work exists only as uncommitted changes; CI (which runs on pushed refs) has never executed it.
- Why wrong: no release, review, or CI gate can attest to the audited state; loss of the sandbox loses security work.
- Expected: committed branch + green CI run on the exact tree before any production claim.
- Action this cycle: PRESERVED all user changes (rule: never discard); documented; journal↔files verified 1:1 (33 entries). 0029's in-place edit was left intact because it is unreleased (uncommitted) work, with the caveat recorded in FINAL_MIGRATION_REVIEW.md.

## F-P1-02 · Dashboard ships full document payloads in list queries + 3–6 s polling
- Severity: P1 · Category: Performance/PII · Confidence: HIGH
- Location: `src/app/dashboard/page.tsx:53`, `src/app/actions.ts:getDashboardState`
- Observed: `db.select().from(printJobs)…limit(50)` returned the whole row incl. `payload` (base64 docs to ~5 MB); polled every 6 s (3 s while pairing).
- Fix: metadata-only projections in both queries; inspector lazy-loads via `GET /api/jobs/[id]` with loading/aria-live states (`dashboard-client.tsx`).
- Regression test: `tests/dashboard-payload-projection.test.ts` (NOT VERIFIED — no DB here; CI must run).
- Compatibility: `Job.payload` remains optional; `[id]` route unchanged.

## F-P1-03 · Security docs assert transport controls the code deliberately lacks
- Severity: P1 · Category: Security-documentation · Confidence: HIGH
- Locations: `docs/PRODUCTION_TLS.md:9-11`, `docs/SECURITY.md:37`, `docs/DEPLOYMENT.md:68`, `ARCHITECTURE.md:158`, `docs/PRODUCTION_READINESS.md` gates, `agent/configs/config.yaml.example:2-3`
- Observed vs code: docs claim http/private-target rejection + env opt-in gates; code (`gateway_config.py:63`, `config.go:68-71`) and pinned tests (`test_http_gateway_url_is_accepted_for_any_host`) prove acceptance by design.
- Fix: all six documents corrected to actual behavior + explicit plaintext-credential warning. No runtime behavior changed (tests pin zero-config acceptance).

## F-P2-01 · Cross-cursor self-deadlock in interactive Odoo submit
- Severity: P2 (availability) · Category: Correctness/concurrency · Confidence: HIGH (static)
- Location: `print_job.py::_handle_pre_dispatch_failure` (~728) + `_persist_state` (~454)
- Observed: raise-on-failure mode wrote failover state on caller cursor C1, then terminal state via dedicated cursor C2 → C2 blocks on C1's uncommitted row lock; C1 waits on C2 → worker hang invisible to PG deadlock detection.
- Fix: all raise-path writes route through `_persist_state`; `SET LOCAL lock_timeout='5s'` fail-loud guard added; cache reload via `invalidate_recordset` so the loop iteration posts to the backup.
- Regression test: `test_04b2_interactive_failover_never_deadlocks` (NOT VERIFIED — no Odoo runtime; CI must run). Odoo `py_compile` PASS.

## F-P2-02 · Pairing-code model: 30-bit space, unsalted hash, no pending-code uniqueness
- Severity: P2 · Category: Security · Confidence: HIGH
- Location: `src/lib/agent-auth.ts:10-20`, `src/app/api/agent/register/route.ts:90-98`
- Observed: unsalted SHA-256 of a 6-char code (precomputable); register lookup global to tenant.
- Fix (partial, justified): new migration `0032` = guarded partial UNIQUE index on non-null `pairing_code_hash` (abort-loud on legacy collisions, never deletes) + schema mirror + collision-retry loops in `createAgent` and re-enable mint. Code-length/HMAC hardening deferred (3-language contract; documented plan item).
- Compatibility: additive index; no behavior change on fresh DBs.

## F-P2-03 · /api/metrics requires undocumented PLATFORM_TENANT_ID
- Severity: P2 · Category: Observability · Confidence: HIGH
- Fix: documented in OPERATIONS.md, docs/DEPLOYMENT.md, `.env.example`. Behavior kept (platform-only metrics is correct for multi-tenant).

## F-P2-04 · Dead identity scaffolding misrepresents the model
- Severity: P2 · Category: Maintainability/security-clarity · Confidence: HIGH
- Location: `users`/`tenant_users`/`applications` tables, `withTenant()`, `backfill_tenants.ts` stub user
- Action: documented, removal deferred (data-destructive owner decision). No code change.

## F-P2-05 · No graceful shutdown in custom server
- Severity: P2 · Category: Reliability · Confidence: MEDIUM (static + design)
- Location: `server.ts`
- Fix: SIGTERM/SIGINT drain (WS close 1001 first → poll fallback takes over, `server.close()`, pool end, 10 s hard-exit backstop). Syntax-verified; runtime behavior NOT VERIFIED here.

## F-P2-06 · Example secrets pass production validation
- Severity: P2 · Category: Secrets · Confidence: HIGH
- Location: `.env.example`, `server.ts` startup checks
- Fix: exact-match refusal of the four known placeholder literals for JWT/proxy secrets in production.

## F-P2-07 · Unbounded aggregate poll response (20×5 MB)
- Severity: P2 · Category: DoS · Confidence: MEDIUM
- Action: documented mitigation guidance; protocol change deferred (would alter agent contract).

## F-P3-* · Fixed: WS close-handler set race (identity guard, `ws.ts:194`); `deleteAgent` bare Error→ActionError 409; canonicalize codepoint ordering (ASCII-identical, no fingerprint drift); test-print `limit: 500`→constant; DOCS.md dead link; DEVELOPMENT.md toolchain table; API.md coverage qualifier; config.yaml.example claim; `.env.example` additions (ODOO_DATABASE_NAME truthfully marked informational); Caddy 2.11.3→2.11.4 patch.
## Deferred with rationale (Phase 2/11: no gratuitous changes)
- `transitionAgentLifecycle` row-locking (admin-console concurrency; documented).
- TypeScript 7 / vitest 5 / ESLint 10 / Go 1.27 language / zeroconf replacement / Next 16.3.5 (lockfile regeneration blocked without installs).
- Batch-status key-rotation semantics (operational note instead).
- link-local allow vs agent-scan deny (reviewed: intentional, mDNS reality).
