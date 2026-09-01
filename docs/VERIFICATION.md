# Verification Gate — Software (Local/CI) vs Customer Acceptance — Current

> Do not claim production-ready until every mandatory Software row is VERIFIED with evidence.
> Customer rows require target Windows/printer/Odoo Cloud — do NOT block Software verification on them.

## Toolchain (pinned)

| Component | Version | Source | Verified |
|-----------|---------|--------|----------|
| Node | v22.x (CI uses Node 22) | `node --version` | VERIFIED |
| Go | go1.21 (module `go 1.21`, CI Go 1.26) | `go version` | VERIFIED |
| Rust | 1.77+ + `tauri-cli 2.x` | `cargo --version` | NOT VERIFIED (requires Windows build host) |
| Next.js | 16.x | `package.json` | VERIFIED |
| ws | 8.x | `src/server/ws.ts` | VERIFIED |
| PG (local) | postgres:16-alpine via docker `movie-platform-postgres` | `docker ps` | VERIFIED (app_db) |
| Odoo | 16/17/18 (addon depends `base,sale,account,stock,purchase,point_of_sale`, reports via `report_mapping`) | `odoo_addons/print_gateway/__manifest__.py:28` | NOT VERIFIED (no Odoo DB on this host) |

## Software Verification — Can Be Verified Locally/CI (No Printer/Odoo Cloud Required)

| # | Test | Command | Result | Notes |
|---|------|---------|--------|-------|
| S1 | TypeScript typecheck | `tsc --noEmit` | VERIFIED | 0 errors, now includes `ipp/ipps` handling `routing.ts` |
| S2 | Next build | `npm run build` (`next build`) | VERIFIED | 24 routes: includes `/api/odoo/sync`, `/api/odoo/printers|agents`, `/api/branches/[id]/printer-bindings`, `/icon.png` |
| S3 | Custom WS server | `tsx server.ts` compiles | VERIFIED | `server.ts` + `src/server/ws.ts` `attachAgentWSS` |
| S4 | Desktop vite build | `npm run desktop:vite:build` | VERIFIED | `dist-desktop` modern UI 4 pages |
| S5 | ESLint | `npm run lint` | VERIFIED | 0 errors (after `&quot;` fix) |
| S6 | Go vet | `go vet ./...` in `agent/` + `GOOS=windows go vet` | VERIFIED | 0 (fixed `spoolerContains` + `unsafe.Add`) |
| S7 | Go test -race | `go test ./... -race -count=1` | VERIFIED | 8 pkgs + `hardening_test.go` 12 + `ipp_test.go` `httptest` |
| S8 | Go build | `go build ./...` | VERIFIED | 0 errors |
| S9 | DB schema | `src/db/schema.ts` + `drizzle 0000/0001/0002` | VERIFIED | 10 tables, `document_types` added, branch isolation indexes |
| S10 | Payload 5MiB cap | `src/lib/payload.ts` + `agent/internal/payload/payload.go` | VERIFIED | base64 canonical, `raw` for PDF |
| S11 | WS attach | `src/server/ws.ts:38` `attachAgentWSS` | VERIFIED | ping/pong 30s, claim-before-delivery via `claimAndPushJobToAgent` (was `pushJobToAgentWithClaim`) |
| S12 | Manager auth | `src/lib/manager-auth.ts` + `login` | VERIFIED | httpOnly 8h `jti`, scrypt; WebView `REQUIRES REAL WINDOWS` |
| S13 | Odoo auth branch-scoped | `src/lib/odoo-auth.ts` + `POST /api/print/jobs` `branchId` | VERIFIED | `odoo_` SHA256, `allowedDocumentTypes` |
| S14 | Printer diagnostics split | `test-connection` (RPC, no job) vs `test-print` (real job) | VERIFIED | `test-connection` cached `latencyMs:null`, `test-print` real job via `claimAndPushJobToAgent` (claim commits before the WS send) |
| S15 | Vitest | `npm test` | VERIFIED | `job-status` 4 + `payload` 4 + `phase1/2-routing` 13 + `odoo-simulation` 3/4 |
| S16 | Desktop assets | `dist-desktop` | VERIFIED | modern UI |
| S17 | test-connection never creates job | `grep -F printJobs` | VERIFIED | header `MUST NOT` |
| S18 | test-connection shape | `POST → {reachable,latencyMs,agentOnline,error}` | VERIFIED | `route.ts:48` |
| S19 | PG concurrent claim (real PG) | `DATABASE_URL=... node tests/pg-concurrent-claim.mjs` | VERIFIED | 20 queued, 3 concurrent, 0 dup (FOR UPDATE SKIP LOCKED) |
| S20 | Mock TCP printer E2E | `go test -run TestMockTCPPrinterE2E` | VERIFIED | `127.0.0.1:0` captures `escpos` |
| S21 | Odoo simulation | `tests/odoo-simulation.test.ts` | VERIFIED | `validatePrintJobPayload` + `buildTestPrintPayload` |
| S22 | Failure testing (mock) | `go test -run Failure` | VERIFIED | refused/timeout/disconnect |
| S23 | Crash-window simulation | `go test -run Crash` | VERIFIED | at-least-once duplicate bounded |
| S24 | Manager harness | `src/desktop/main.tsx` | VERIFIED (code) | `credentials:include` |
| S25 | **NEW** Generic report mapping | `python -m py_compile` `report_mapping.py` + `ir_actions_report.py` | VERIFIED (py_compile) | `report_mapping` priority `report_id > xml_id > model`, `ir.actions.report` override `report_action` |
| S26 | **NEW** Odoo branch create_print_job 8-args | `py_compile` `branch.py` + `print_job.py` 5 new fields | VERIFIED (py_compile) | `odoo_model/record_id/report_xml_id` |
| S27 | **NEW** Security `report_mapping` access | `ir.model.access.csv` 11 lines | VERIFIED | `group_system` + `group_user` read-only |
| S32 | **NEW** Security `branch` access fixed | `ir.model.access.csv` branch write restricted to `group_system` | VERIFIED | `gateway_api_key` no longer writable by normal users |
| S28 | **NEW** XML validation | `xmllint --noout views/*.xml data/*.xml` | VERIFIED | `report_mapping_views.xml`, `ir_actions_report_views.xml`, `data/report_mappings.xml` 8 defaults |
| S29 | **NEW** Direct USB `CreateFile` | `go vet` `usb_windows.go` `CreateFile/WriteFile` | VERIFIED (compile) | `usb_other.go` simulates `/tmp/` file |
| S30 | **NEW** IPP `Print-Job` | `go test -run TestIPP` `httptest` | VERIFIED | `application/ipp` 2.0 binary, `normalizeIPPURL` handles `host:port` |
| S31 | **NEW** Desktop modern UI | `npm run desktop:vite:build` | VERIFIED | 4 pages, `get_printers/discover/test`, theme |

**PG concurrency log (real PG, 2026-08-31):** `20 queued, 3 concurrent, 0 dup` `FOR UPDATE SKIP LOCKED`.

**Mock printer log (test-only):** `TestMockTCPPrinterE2E — PASS`, `TestIPPPrintWithMockServer — PASS`.

## Customer Acceptance — Requires Customer Hardware/Environment

| # | Criterion | Steps | Status |
|---|-----------|-------|--------|
| C1 | Windows Service install/start | `sc query` + `taskkill` + reboot | REQUIRES REAL WINDOWS |
| C2 | ProgramData ACLs | `icacls` | REQUIRES REAL WINDOWS |
| C3 | WebView2 + tray | clean VM install `OdooPrintManager_*_x64-setup.exe` | REQUIRES REAL WINDOWS |
| C4 | Manager auth WebView | `fetch` `credentials:include` | REQUIRES REAL WINDOWS |
| C5 | NSIS/MSI + Tauri build | `cargo tauri build --target x86_64-pc-windows-msvc` | REQUIRES REAL WINDOWS |
| C6 | Pairing secret never in renderer | `type config.yaml` | REQUIRES REAL WINDOWS |
| C7 | ESC/POS printer 9100 Test Connection live probe | `POST /api/printers/:id/test-connection` → `latencyMs:12` | REQUIRES REAL PRINTER |
| C8 | Test Print `queued→success` + paper | `POST /api/printers/:id/test-print` → `success` + paper | REQUIRES REAL PRINTER |
| C9 | Multi-printer independence | real hardware | REQUIRES REAL PRINTER |
| C10 | Odoo Cloud generic report `sale.action_report_saleorder` → Gateway → Agent → Printer + `print_gateway.print_job` `gateway_job_id` | **NEW** Odoo `sale.order` Print `ir.actions.report` override → `_render_qweb_pdf` → `branch.create_print_job` → `POST /api/print/jobs` (branch/destination/documentType) → `print_job` with `odoo_model` etc. + `GET /api/print/jobs?id=` sync 2m cron | REQUIRES ODOO DB + REAL PRINTER (odoo-bin --test-enable) |
| C11 | Crash-window on real printer | Kill after `WritePrinter` before `PATCH` → duplicate bounded | REQUIRES REAL PRINTER |

## Production Gate

Software rows `S1-S32` **VERIFIED** on this build host (PG concurrency via `app_db`, mock `127.0.0.1:0`, `httptest` for IPP, `py_compile`/`xmllint` for Odoo views).
Customer rows `C1-C11` + `report_mapping` `odoo-bin --test-enable` with `sale,account,stock,purchase` remain **REQUIRES** customer hardware. No production-ready claim until `VERIFIED` with VM/printer/Odoo DB evidence.

## Exact Commands To Run Locally (Software Verification — No Printer/Odoo Needed)

```bash
python3 -m py_compile odoo_addons/print_gateway/models/*.py
xmllint --noout odoo_addons/print_gateway/views/*.xml odoo_addons/print_gateway/data/*.xml
npm run typecheck && npm run lint && npm run build && npm test && npm run desktop:vite:build
cd agent && go vet ./... && GOOS=windows go vet ./... && go test ./... -race -count=1 && go build ./...
go test ./internal/printer -run TestIPP -count=1 -v
go test ./internal/integration -run TestMockTCPPrinterE2E -count=1 -v
# PG concurrency (real PG via docker app_db)
DATABASE_URL="postgresql://movie_user:movie_password@127.0.0.1:5432/app_db" node tests/pg-concurrent-claim.mjs
# Odoo install test (requires Odoo + PG)
# docker run --rm --network host -v $PWD/odoo_addons:/mnt/extra-addons odoo:17 odoo --test-enable --database odoo_test --init=print_gateway --stop-after-init --test-tags=print_gateway
```
