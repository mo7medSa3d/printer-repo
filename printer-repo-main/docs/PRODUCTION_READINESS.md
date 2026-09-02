# Production readiness

Status of the repository at the commit that introduced this document. Every "verified" claim
below corresponds to a command that was actually executed; every gap is named explicitly.

## Verdict

**NOT PRODUCTION-READY FROM THE VERIFIED SCOPE.**

This workspace did not have the dependency/runtime infrastructure needed to execute the full software check battery. The repository contains real PostgreSQL/agent/Odoo test harnesses and CI gates, but this local pass does not claim them as executed. Windows spooler/USB printing, the Windows PDF submission call, a real IPP printer, and a live Odoo instance remain unverified. Until
[../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) has been executed and its result
table filled in, do not describe the system as production-verified.

## 1. Verified in this workspace

| Area | Evidence |
|---|---|
| Python/Odoo source syntax | `python3 -m compileall -q odoo_addons/print_gateway` — PASS |
| Workflow/package metadata syntax | YAML, `package.json`, and Drizzle journal JSON parse — PASS |
| Go formatting | `gofmt` over modified Go files — PASS |
| Node unit/lint/typecheck/build | Commands executed but blocked by unavailable npm dependencies. `npm test`/`npm run lint`/`npm run build` exit 127; `npm run typecheck` exits 2 with dependency/module-resolution errors. |
| Go test/vet | Commands executed from `agent/`; module downloads failed because external network/DNS is unavailable. No pass claimed. |
| PostgreSQL integration | Not executable: `psql` and Docker are unavailable and no PostgreSQL service is running. CI contains the real PostgreSQL gate. |
| Odoo runtime tests | Not executable: Odoo runtime is unavailable. Odoo test files are included and Python syntax was validated. |
| Windows/Tauri/physical-printer E2E | Not executable on this Linux workspace; Windows and hardware are unavailable. |

## 1.1 Required CI verification

`.github/workflows/ci.yml` is the authoritative CI gate. It runs Node lint/typecheck/tests/build against a real PostgreSQL 16 service, applies migrations before the test suite, and runs Go test/vet. `.github/workflows/build-windows.yml` remains the Windows packaging/E2E gate.

## 2. Environment-dependent verification (open)

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
6. **No `Content-Length` pre-check** before JSON parsing (the 5 MiB cap is enforced during
   validation). Manager login is rate-limited per IP and per account in PostgreSQL
   (`auth_rate_limits`, migration `0005`).
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
**NOT PRODUCTION-READY FROM THE VERIFIED SCOPE — physical printing, Odoo runtime, Windows/Tauri packaging, and real PostgreSQL execution were not available in this workspace.**
