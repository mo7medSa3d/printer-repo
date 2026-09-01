# Production readiness

Status of the repository at the commit that introduced this document. Every "verified" claim
below corresponds to a command that was actually executed; every gap is named explicitly.

## Verdict

**PRODUCTION READY WITH WARNINGS — pending hardware verification.**

The software paths are exercised end to end against a real PostgreSQL and a real agent
WebSocket, and the whole check battery passes. What is **not** proven anywhere in this
repository is the part that needs physical devices: Windows spooler/USB printing, the
Windows PDF submission call, a real IPP printer, and a live Odoo instance. Until
[../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) has been executed and its result
table filled in, do not describe the system as production-verified.

## 1. Verified (executed here)

| Area | Evidence |
|---|---|
| Type checking, linting, production build | `npm run typecheck`, `npm run lint`, `npm run build` — clean |
| Gateway unit + contract tests | `npm test` → 67 passed, 33 skipped (database suites skipped without `DATABASE_URL`) |
| Gateway database-backed tests | `DATABASE_URL=… npm test` → **100 passed, 0 skipped** across 11 files against real PostgreSQL 18 |
| Claim-before-delivery, ack, requeue, lease reclaim, concurrency | `tests/ws-claim-delivery.test.ts` (real WS client + real DB) |
| Odoo sync validation, rollback, idempotency, concurrency | `tests/odoo-sync-transaction.test.ts` |
| Routing availability + document-type authorization | `tests/routing-availability.test.ts` |
| Odoo → gateway → agent socket → status (software only) | `tests/e2e-job-flow.test.ts` |
| Agent build/vet/test/race | `go build ./...`, `go vet ./...`, `go test ./...`, `go test -race ./...` — 8 packages, 88 test functions, no data races |
| PDF pipeline: validation, secure temp file lifecycle, argv safety, backend matrix | `agent/internal/printer/pdf_test.go` |
| Crash recovery marking and reprint policy | `agent/internal/agent/ws_delivery_test.go`, `agent/internal/queue/queue_test.go` |
| Windows cross-compilation | `GOOS=windows GOARCH=amd64 go build ./...` and `GOOS=windows go vet ./...` — clean |
| Migrations on a fresh database | `drizzle/0000 → 0004` applied in order; schema compared column-by-column with `src/db/schema.ts` (10/10 tables match) |
| Odoo addon syntax | `python -m py_compile` on the models, XML well-formedness on all 13 addon XML files |
| Whitespace/diff hygiene | `git diff --check` clean |

## 2. Hardware-dependent verification (open)

| Item | Status |
|---|---|
| Physical page from a Windows spooler printer | **NOT VERIFIED — requires hardware** |
| Windows PDF submission (`ShellExecuteExW` + `printto`, handler exit code) | **COMPILE VERIFIED** only |
| Windows spooler RAW path (`winspool.drv`), USB `CreateFile`, `EnumPrintersW`/`SetupDi` discovery | **COMPILE VERIFIED** only |
| Real IPP printer (`Print-Job`, `application/pdf`) | **NOT VERIFIED** (only `httptest`-level coverage) |
| Real RAW/ESC-POS thermal printer on :9100 | **NOT VERIFIED** (mock TCP listener only) |
| Tauri app on Windows: install, tray, pairing, service control | **REQUIRES WINDOWS** — covered by CI on `windows-latest`, not by this workspace |
| Live Odoo end-to-end (report → job → paper) | **REQUIRES LIVE ODOO** |

Procedure to close these: [../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md).

## 3. Previously known issues — current state

| Issue | State | Evidence |
|---|---|---|
| WebSocket claim race (job pushed before it was claimed; agent could report progress on a `queued` row) | **FIXED** | Claim commits inside a transaction before the socket write (`src/lib/job-delivery.ts`, `src/server/ws.ts`); `tests/ws-claim-delivery.test.ts` |
| PDF printed as RAW bytes | **FIXED** | Distinct `pdf` kind end to end + real Windows PDF path (`agent/internal/printer/pdf*.go`); `pdf_test.go`, `regression-critical.test.ts` |
| Odoo sync applied partially / auto-created printers / returned `success` on failure | **FIXED** | Validate-then-single-transaction with `SYNC_VALIDATION_FAILED` / `SYNC_DEPENDENCY_MISSING` (`src/app/api/odoo/sync/route.ts`); `tests/odoo-sync-transaction.test.ts` |
| `PRINTER_DISABLED` declared but never returned (disabled printers reported as `PRINTER_OFFLINE` 503) | **FIXED** | `lastDisabledPrinter` tracking in `src/lib/routing.ts`; `tests/routing-availability.test.ts` asserts 409 + code |
| `isOdooKeyAllowedForDocumentType` case-sensitive while routing lower-cases (legitimate `Invoice` jobs rejected with 403) | **FIXED** | Both sides trimmed/lower-cased in `src/lib/odoo-auth.ts`; unit + HTTP-level tests |
| Agent crash could reprint silently (at-least-once, invisible) | **IMPROVED, STILL AT-LEAST-ONCE** | Interrupted jobs are marked `AGENT_RESTART_DURING_PRINT`, reported immediately, and `agent.reprint_after_crash` can forbid automatic reprints. **Exactly-once physical printing is not claimed** |
| Documentation drift (old architecture, "PDF as raw", stale counts) | **FIXED** | Full documentation re-sync; obsolete documents deleted |

## 4. Known limitations (by design or unfixed)

1. **At-least-once printing.** A crash between "bytes handed to the printer" and "status
   recorded" leaves an ambiguous job. It is now reported explicitly, but the physical outcome
   cannot be known. No exactly-once guarantee exists.
2. **`test-connection` is not a live probe.** It returns cached heartbeat data; `latencyMs`
   is always `null` because the gateway cannot dial the LAN.
3. **mDNS / SNMP / WSD discovery are stubs** that only log "not yet implemented".
4. **Multi-instance WebSocket push.** Sockets are tracked per process; with several gateway
   instances a job created on another instance reaches the agent through polling (≤ 10 s)
   instead of an immediate push. Claiming remains correct (`FOR UPDATE SKIP LOCKED`).
5. **Manager authorization is coarse** — one global role, not branch-scoped.
6. **No rate limiting** on authentication endpoints; no `Content-Length` pre-check before
   JSON parsing (the 5 MiB cap is enforced during validation).
7. **PDF on non-Windows hosts** requires an explicit `pdf_print_command`; otherwise it fails
   loudly (the spooler stub only simulates and says so).
8. **Odoo addon tests** require a live Odoo runner; only syntax/XML checks run here.

## 5. Go/No-go checklist for a production launch

- [ ] Migrations `0000 → 0004` applied to the production database
- [ ] `GATEWAY_JWT_SECRET` ≥ 32 random characters, `MANAGER_PASSWORD_HASH` set (not plaintext)
- [ ] TLS terminated in front of the gateway; the proxy forwards `/api/agent/ws` upgrades
- [ ] Branch-scoped Odoo API keys issued per branch, `allowedDocumentTypes` set where useful
- [ ] Agents paired, heartbeating, and reporting accurate `capabilities.supported_protocols`
- [ ] `agent.reprint_after_crash` decided per site (duplicates vs. lost documents)
- [ ] PDF path proven on each printer model that must print PDFs
- [ ] [../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) executed, result table filled in,
      including the deliberate-failure run
- [ ] Database backups and monitoring for stuck `claimed` jobs and `retries >= 3`

Until every box is ticked, the honest status of this system is
**PRODUCTION READY WITH WARNINGS — physical printing NOT VERIFIED**.
