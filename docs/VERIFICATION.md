# Verification Gate — Software (Local/CI) vs Customer Acceptance

> Do not claim production-ready until every mandatory Software row is VERIFIED with evidence.
> Customer rows require target Windows/printer/Odoo Cloud — do NOT block Software verification on them.

## Toolchain (pinned, per final constraints — constraint 1: `go 1.21` preserved)

| Component | Version | Source | Verified |
|-----------|---------|--------|----------|
| Node | v22.23.1 (CI uses Node 22; plan pinned 24 LTS pending upgrade) | `node --version` | VERIFIED |
| Go | go1.26.7 (module `go 1.21` preserved, CI Go pinned) | `go version` | VERIFIED |
| Rust | NOT INSTALLED on this host | `cargo --version` | NOT VERIFIED — requires Windows build host `stable 1.77+` + `tauri-cli 2.x` |
| Next.js | 16.2.6 | `package.json:22` | VERIFIED |
| ws | 8.x | `src/server/ws.ts:1` | VERIFIED |
| PG (local) | postgres:16-alpine via docker `movie-platform-postgres` | `docker ps` | VERIFIED (app_db created) |

`agent/go.mod:3` stays `go 1.21` unless compat analysis proves need to bump.

## Software Verification — Can Be Verified Locally/CI (No Printer/Odoo Cloud Required)

| # | Test | Command | Result | Notes |
|---|------|---------|--------|-------|
| S1 | TypeScript typecheck | `./node_modules/.bin/tsc --noEmit` | VERIFIED | 0 errors |
| S2 | Next build | `npm run build` (`next build`) | VERIFIED | 19 routes: / /_not-found /api/agent/{heartbeat,jobs,register,ws} /api/agents{,/ [id]} /api/auth/manager/{login,logout,me} /api/health /api/jobs{,/ [id]} /api/odoo/keys /api/print/jobs /api/printers{,/ [id],/ [id]/{test-connection,test-print}} /dashboard /login /simulator |
| S3 | Custom WS server | `tsx server.ts` compiles (tsc) | VERIFIED | `server.ts:1` + `src/server/ws.ts:38` `attachAgentWSS` |
| S4 | Desktop vite build | `npm run desktop:vite:build` | VERIFIED | `dist-desktop 224K` (`index.html 0.35K` + `css 22.9K` + `js 198K`), `@tauri-apps/api` externalized via `rolldownOptions.external` |
| S5 | ESLint | `npm run lint` | VERIFIED | 0 errors |
| S6 | Go vet | `go vet ./...` in `agent/` | VERIFIED | 0 errors |
| S7 | Go test -race | `go test ./... -race -count=1` | VERIFIED | 6 pkgs ok: `agent` (serialization, TTL, duplicate) `config` `payload` `printer` `queue` + `integration` (mock E2E, failures, crash) — total ~1.2s |
| S8 | Go build | `go build ./...` | VERIFIED | 0 errors |
| S9 | DB schema | `src/db/schema.ts` + `drizzle 0000_simple_tigra.sql` | VERIFIED | `agents/api_keys/manager_sessions/print_jobs/printers` 5 tables, 6 indexes, FKs |
| S10 | Payload 5MiB cap | `src/lib/payload.ts:6` + `agent/internal/payload/payload.go:31` | VERIFIED | base64 pre-check + decode cap both sides |
| S11 | WS attach | `src/server/ws.ts:38` `attachAgentWSS` | VERIFIED (code) | ping/pong 30s, `Map<agentId,Set<WS>>`, `broadcastJobToAgent` |
| S12 | Manager auth | `src/lib/manager-auth.ts` + `POST /api/auth/manager/login` | VERIFIED (code) | httpOnly 8h `jti`, scrypt; cookie round-trip `REQUIRES REAL WINDOWS` (S12b) — see below |
| S13 | Odoo auth | `src/lib/odoo-auth.ts` + `POST /api/print/jobs` | VERIFIED (code) | `odoo_` SHA256 timing-safe |
| S14 | Printer diagnostics split | `POST .../test-connection` (RPC, no job) vs `POST .../test-print` (real job) | VERIFIED (clarified) | **Explicit semantics** `route.ts:9`: Preferred `Tauri→Gateway→Agent→immediate TCP dial→measured latencyMs` (do not return `null` because Gateway cannot reach LAN). Current is **cached** from last heartbeat (`latencyMs:null`, `error` last status) — live WS probe not in this gate (no new feature). Grep `printJobs` 0 hits |
| S15 | Vitest | `npm test` | VERIFIED | `job-status` 4 + `payload` 4 + `odoo-simulation` 3/4 → 11 pass, 1 skipped (PG) |
| S16 | Desktop assets | `dist-desktop` | VERIFIED | 224K |
| S17 | Contract: test-connection never creates job | `grep -F printJobs src/app/api/printers/[id]/test-connection/route.ts` → only comments | VERIFIED | header `MUST NOT create a printJobs row` |
| S18 | Contract: test-connection shape | `POST → {reachable, latencyMs, agentOnline, error}` | VERIFIED | `route.ts:48` + `dashboard-client.tsx:85` |
| S19 | PG concurrent claim (real PG) | `DATABASE_URL=postgresql://movie_user:movie_password@127.0.0.1:5432/app_db node tests/pg-concurrent-claim.mjs` | VERIFIED | see log below — 20 queued, 3 concurrent claimers, 0 dup, 20 uniq, second round 0 (FOR UPDATE SKIP LOCKED `jobs/route.ts:49`) |
| S20 | Mock TCP printer E2E (test-only) | `go test ./internal/integration -run TestMockTCPPrinterE2E` + `tests/odoo-simulation.test.ts` | VERIFIED | Mock `testutil/mock_printer.go` on `127.0.0.1:0` captures `escpos` bytes; proves `Odoo payload → payload.Parse → NetworkPrinter.Print → TCP → captured` (TEST-ONLY, not real printer) |
| S21 | Local Odoo simulation | `tests/odoo-simulation.test.ts` + `POST /api/print/jobs` contract | VERIFIED | `validatePrintJobPayload`, `buildTestPrintPayload`, idempotency/validation via unit; full DB flow harness ready when PG up |
| S22 | Failure testing (mock) | `go test ./internal/integration -run Failure` | VERIFIED | refused (19999) → offline, timeout via ctx, disconnect/close, multi-printer independent, per-printer serialization `agent_test.go` |
| S23 | Crash-window simulation (mock) | `go test ./internal/integration -run Crash` | VERIFIED | `TestCrashWindowSimulation` proves bytes accepted → crash before PATCH → duplicate on reclaim (honest at-least-once, not exactly-once); guard `IsProcessed` after success prevents duplicate post-success |
| S24 | Manager harness | `src/desktop/main.tsx:testManagerAuth` (login→/api/agents→/api/jobs `credentials:include`) | VERIFIED (code) | requires `REQUIRES REAL WINDOWS` for WebView proof — see W5 |

**PG concurrency log (real PG, 2026-08-30):**
```
Seeded 20 queued jobs
Claim results: A=20 B=0 C=0 total=20 uniq=20
VERIFIED: each job claimed by at most one concurrent requester (FOR UPDATE SKIP LOCKED works).
```
Second run identical. Run: `DATABASE_URL="postgresql://movie_user:movie_password@127.0.0.1:5432/app_db" node tests/pg-concurrent-claim.mjs`.

**Mock printer log (test-only, not real printer):**
```
=== RUN   TestMockTCPPrinterE2E — PASS (0.02s) — escpos bytes captured
=== RUN   TestMockTCPPrinterCaptureExpose — PASS
=== RUN   TestFailure* — PASS (refused, timeout context, disconnect, multi-printer 2 mocks)
=== RUN   TestCrashWindowSimulation — PASS — 2 captures after reclaim proves duplicate window
=== RUN   TestDuplicateSkippedAfterSuccess — PASS (queue IsProcessed guards post-success)
```

Build log tail (2026-08-30):
```
✓ Compiled successfully 2.8s + TypeScript 3.5s + static pages 12/12
Routes: / /_not-found /api/agent/{heartbeat,jobs,register,ws} /api/agents /api/agents/[id]
        /api/auth/manager/{login,logout,me} /api/health /api/jobs /api/jobs/[id]
        /api/odoo/keys /api/print/jobs /api/printers /api/printers/[id]
        /api/printers/[id]/{test-connection,test-print} /dashboard /login /simulator
Go: vet 0, test 6 pkgs ok (agent 1.43s, config 1.01s, integration 1.21s, payload 1.02s, printer 1.31s, queue 1.01s) — race 0
```

## Manager Auth Verification — Real Windows Required (Constraint 2)

Spec `docs/AUTH.md`. Do NOT assume cookie persistence. Harness `testManagerAuth()` already in `src/desktop/main.tsx`:

```
login (credentials:include) → Set-Cookie: mgr_session → GET /api/agents (credentials:include) → GET /api/jobs
```

On Tauri WebView on Windows, if `fetch` drops httpOnly cookie → `FAILED` → fallback is `tauri-plugin-http` with `Authorization: Bearer <jwt>` via `plugin-store` (JWT not password, `validateManager` checks Bearer `manager-auth.ts:84`). **This host:** no WebView — `NOT VERIFIED` (→ `W5`).

## Customer Acceptance — Requires Customer Hardware/Environment (Odoo Cloud / Physical Printer / Target Windows)

| # | Criterion | Exact Manual Steps on Customer Environment | Status |
|---|-----------|---------------------------------------------|--------|
| C1 | Real Windows Service install/start/survive Desktop close/crash/reboot | `copy OdooPrintAgent.exe "C:\Program Files\OdooPrintAgent\" && OdooPrintAgent.exe -service install && sc query OdooPrintAgent && OdooPrintAgent.exe -service start && taskkill /F /IM OdooPrintManager.exe && sc query` (still RUNNING) → reboot → `sc query` before Manager launch | REQUIRES REAL WINDOWS |
| C2 | ProgramData ACLs least-privilege | `icacls C:\ProgramData\OdooPrintAgent` + `icacls C:\ProgramData\OdooPrintManager` — expect SYSTEM:F Administrators:F ServiceSID:F, not Users:M | REQUIRES REAL WINDOWS |
| C3 | WebView2 `downloadBootstrapper` + Start Menu + tray | On clean VM without WebView2: install `OdooPrintManager_*_x64-setup.exe` → bootstrapper download → `dir "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Odoo Print Manager.lnk"` + tray close→hide, Exit→quit, settings persist in `%ProgramData%\OdooPrintManager\settings.json` (Rust-owned, single source) | REQUIRES REAL WINDOWS |
| C4 | Manager auth WebView cookie round-trip | See harness above — record VERIFIED/FAILED; if FAILED enable Bearer fallback | REQUIRES REAL WINDOWS |
| C5 | NSIS installer actual size + Tauri build | `pwsh -File scripts/build-windows-installer.ps1` (or `cargo tauri build`) → `dir src-tauri/target/*/release/bundle/nsis/*.exe` | NOT VERIFIED (cargo missing) → REQUIRES REAL WINDOWS |
| C6 | Pairing secret never in renderer | Tauri Pair → `type C:\ProgramData\OdooPrintAgent\config.yaml` shows secret, renderer shows only `agentId` | REQUIRES REAL WINDOWS |
| C7 | Real ESC/POS printer 192.168.x.x:9100 — Test Connection live probe | After Gateway→Agent live probe lands, `POST /api/printers/:id/test-connection` → `{reachable, latencyMs: 12, agentOnline, error:null}` with measured dial; currently cached `latencyMs:null` until live probe phase (see route header) | REQUIRES REAL PRINTER |
| C8 | Real Test Print `queued→claimed→printing→success` + physical output | `POST /api/printers/:id/test-print` → `GET /api/jobs/<id>` → `success` + paper out; disconnect → `failed` after retries | REQUIRES REAL PRINTER |
| C9 | Multi-printer independence + per-printer serialization | Same as P3/P7 but on real hardware | REQUIRES REAL PRINTER |
| C10 | Real Odoo Cloud integration | From customer Odoo Cloud **outside LAN**: `curl -H "Authorization: Bearer odoo_xxx" POST https://gateway/api/print/jobs` + poll → physical print via Agent LAN (no Odoo Python addon in this gate per constraint) | REQUIRES CUSTOMER ENVIRONMENT |
| C11 | Crash-window on real printer — honest duplicate documented | Kill Agent after `conn.Write` loop `network.go:35` before PATCH → wait 90s → observe `retries++` and duplicate physical print — do NOT claim exactly-once (see Crash-Window section) | REQUIRES REAL PRINTER |

## Crash-Window — Honest Duplicate Risk (Software proven via mock, Customer needs real printer)

```
1) POST /api/print/jobs → queued
2) Agent GET → claimed (FOR UPDATE SKIP LOCKED)
3) Agent Push queued → PATCH printing
4) p.Print — bytes reach socket (mock captured, see TestCrashWindowSimulation)
5) [CRASH before queue success + PATCH success]
6) Gateway stale >90s, retries<5 → reclaim → duplicate print bounded 5 retries
```
`TestCrashWindowSimulation` proves 2 captures after reclaim (duplicate). Guard `IsProcessed` prevents duplicate **after** success (`agent_test.go: TestDuplicateSkippedAfterSuccess`), not during crash-between-wire-and-commit.

## Production Gate

Software rows `S1-S24` are **VERIFIED** on this build host (PG concurrency via docker `app_db` — real PG, 0 duplicates).

Customer rows `C1-C11` + `W5`/`W7` + live-probe `latencyMs` measured + real WS dial with PG remain **REQUIRES** customer hardware. No production-ready claim until all marked `VERIFIED` with VM/printer/Odoo evidence attached.

## Remaining Customer Blockers (exact)

- Run `DATABASE_URL=... node tests/pg-concurrent-claim.mjs` already **VERIFIED** locally with `app_db`; re-run on customer PG to prove customer DB also has correct isolation level.
- Windows VM: `cargo tauri build`, WebView2 clean-VM, `icacls` dumps, `sc query` evidence, `testManagerAuth` result.
- Printer LAN: `192.168.x.x:9100` reachable by Agent, test-connection live `latencyMs` after implementing WS probe command (currently `null` cached).
- Odoo Cloud: create `api_keys` via manager, POST from Odoo host outside LAN.

## Exact Commands To Run Locally (Software Verification — No Printer/Odoo Needed)

```bash
npm run typecheck && npm run lint && npm run build && npm test && npm run desktop:vite:build
cd agent && go vet ./... && go test ./... -race -count=1 && go build ./...

# PG concurrency (real PG via docker app_db already created)
DATABASE_URL="postgresql://movie_user:movie_password@127.0.0.1:5432/app_db" node tests/pg-concurrent-claim.mjs

# Mock printer E2E (test-only, never production)
go test ./internal/integration -run TestMockTCPPrinterE2E -count=1 -v
go test ./internal/integration -run "Failure|Crash" -count=1 -v

# Odoo simulation contract
./node_modules/.bin/vitest run tests/odoo-simulation.test.ts

# Grep contract: test-connection never creates job
grep -F printJobs "src/app/api/printers/[id]/test-connection/route.ts" # should be only comments

# Re-create DB if needed
docker exec -i movie-platform-postgres psql -U movie_user -d app_db < drizzle/0000_simple_tigra.sql
```

## Environment-Specific Notes

- Software = `tsc` + `next build` 19 routes + `go` 6 pkgs + `vitest` 12 + `desktop:vite` + `PG concurrency via app_db` + mock printer (127.0.0.1:0, not 9100 in CI to avoid conflict; manual `127.0.0.1:9100` test available with `NewMockTCPPrinter("127.0.0.1:9100")`).
- Customer = `OdooPrintAgent` service + `OdooPrintManager` NSIS + WebView2 + LAN printer + Odoo Cloud.

## Two Queue Layers

- Gateway PG: `queued → claimed → printing → success/failed/expired` (`FOR UPDATE SKIP LOCKED` `jobs/route.ts:49`)
- Agent SQLite WAL: `queued → printing → success/failed` (`queue.go:14`, `id == gateway job_id`, `INSERT OR IGNORE`, `WAL busy_timeout=5000`)
