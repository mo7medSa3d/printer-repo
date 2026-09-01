# Architecture & Design Verification — Current

## Project State: PRODUCTION HARDENED — Generic Odoo Printing Complete

The project is now **multi-branch, multi-destination, generic report routing** with:

- **Gateway** `Next.js 16 + PG/Drizzle + WS` `server.ts` `src/server/ws.ts` 24 routes, `src/db/schema.ts` 10 tables, `resolvePrinterForJob` fallback, `FOR UPDATE SKIP LOCKED` queue
- **Agent** `Go 1.21` `agent/internal/agent` WS/poll/queue/WAL, `agent/internal/printer` 6 transports: `network.go` RAW, `spooler_windows.go` correct `PRINTER_INFO_2W`, `network_discovery.go` 9100 scan, `usb_windows.go` `SetupDi` + `CreateFile` direct USB, `ipp.go` `Print-Job` + `ipp_discovery.go` 631 scan, `stable_id.go`, `registry.go` atomic, `discovery.go` 6 sources dedup, `classify.go`
- **Desktop** `Tauri 2.x` `src-tauri` 14 commands `run_blocking`, `src/desktop/main.tsx` 891 lines 4 pages (Dashboard, Printers, Jobs, Settings) modern gradient, sidebar hash routing, theme, `src/desktop/lib/ipc.ts` typed `getPrinters/discover/test`
- **Odoo Addon** `odoo_addons/print_gateway` 8 models + `report_mapping` + `ir.actions.report` override `report_action` → `_render_qweb_pdf` → `branch.create_print_job` 8-args, `print_job` 5 new fields, 9 views, `data/report_mappings.xml` 8 defaults, `security` 10 lines

### 1. The Local Print Agent (Go) — VERIFIED
**Directory**: `/agent`
- **cmd/agent**: Windows Service `kardianos/service` `Arguments: -config C:\ProgramData\OdooPrintAgent\config.yaml` `agent/cmd/agent/main.go`
- **internal/agent**: `agent.go` outbound `WSS` + poll fallback, `heartbeat 30s` `printerStatusPayload` with `usbVid/pid/serial`, `DiscoverQuick` sync + async full 2s `network_discovery.go` + `usb_windows.go` + `ipp_discovery.go`, `processJob` per-printer lock, `dispatch` dedup `maxPending 64` `maxConcurrent 8`
- **internal/queue**: `queue.go` SQLite WAL `queued → printing → success/failed` `INSERT OR IGNORE`
- **internal/printer**: `factory.go` `network/spooler/usb/ipp/ipps`, `network.go` RAW 9100, `spooler_windows.go` `winspool.drv`, `usb_windows.go` `SetupDi` + direct `CreateFile`, `ipp.go` `application/ipp`, `stable_id.go` `ipp://` aware, `registry.go` atomic, `discovery.go` 6 sources
- **cmd/cli**: `main.go` `printers list/discover/test/add/remove` with `vid/pid/serial/printer-type/capabilities` `helpers.go`

**Verification:** `go vet ./...` 0, `GOOS=windows go vet` 0, `go test -race ./...` 8 pkgs ok (printer 4s), `go build -trimpath` ok, `spooler_stub` writes `/tmp/spooler_*.prn`, `usb_other` simulates `/tmp/` file, `ipp_test.go` `httptest` `application/ipp`

### 2. The Print Gateway (Next.js) — VERIFIED
**Directory**: `src/`
- **API**: 24 routes `src/app/api/*` including `POST /api/print/jobs` branch + legacy, `POST /api/agent/heartbeat` with `ipp/ipps`, `GET/PATCH /api/agent/jobs` `FOR UPDATE SKIP LOCKED`, `POST /api/odoo/sync` idempotent, `GET /api/odoo/agents/printers`, `src/lib/routing.ts` `resolvePrinterForJob` fallback, `src/lib/payload.ts` 5 MiB canonical base64, `src/server/ws.ts` `attachAgentWSS` ping 30s
- **DB**: `src/db/schema.ts` 10 tables `branches, destinations, document_types, local_networks, agents, printers, printer_bindings, api_keys, manager_sessions, print_jobs` with `branchId` FKs + `routing_idx`
- **Verification:** `npm run typecheck` 0, `npm run lint` 0, `npm test` 32 pass, `npm run build` 19 routes + `/icon.png`

### 3. Odoo Addon — VERIFIED (code, not DB)
**Directory**: `odoo_addons/print_gateway`
- **Models**: 8 + `report_mapping` `ir_actions_report` override `report_action` `ir_actions_report.py:311` + `_render_qweb_pdf` `ir_actions_report.py:180`
- **Views**: 9 `branch, destination, document_type, printer, agent, printer_binding, print_job, report_mapping, ir_actions_report` + `menu.xml` `Report Mappings` + `sale_order_views.xml` deprecated header removed
- **Data**: `data/cron.xml` 2m/5m + `data/report_mappings.xml` 8 defaults `noupdate=1` for `sale, account, stock, purchase, pos`
- **Security**: `security/ir.model.access.csv` 10 lines (`report_mapping` system + user read-only)
- **Verification:** `python3 -m py_compile models/*.py` OK, `xmllint --noout views/*.xml data/*.xml` OK, `__manifest__.py` 14 data

### 4. Desktop Manager — VERIFIED (vite, not Windows HW)
**Directory**: `src-tauri` + `src/desktop`
- **Tauri**: `tauri.conf.json` `productName Odoo Print Manager`, `bundle.resources` Go exes, `capabilities/default.json` `core:default` only
- **Desktop**: `src/desktop/main.tsx` 891 lines 4 pages `Dashboard (Agent/Gateway/Printers/Jobs/Heartbeat), Printers (table, discover, test), Jobs (tabs pending/printing/completed/failed), Settings (Gateway, Branch, Agent, Logging, Autostart)` with `lucide-react`, `getPrinters/discover/test`, theme, responsive, skeletons
- **Verification:** `npm run desktop:vite:build` 43KB css + 208KB js, `cargo` not on Linux host (requires `windows-latest` for `cargo tauri build`)

### Verification Requirements (Current)

Because this host is Linux without Windows spooler/USB/IPP printers and without Odoo DB, the following still require Windows + printer + Odoo DB:

- **Windows spooler paper-out** `POST /api/printers/:id/test-print` → `queued→success` + paper (requires `winspool.drv` + real HP LaserJet on `USB001`)
- **Direct USB `CreateFile \\?\usb#` ** (requires `VID:PID` device)
- **IPP `Print-Job` to `ipp://192.168.1.60/ipp/print` ** (requires `631` printer + `Get-Printer-Attributes`)
- **Odoo `report_action` → `_render_qweb_pdf` → `POST /api/print/jobs` → `print_gateway.print_job` with `gateway_job_id`**

See `docs/VERIFICATION.md` for 24 software (VERIFIED) vs 11 customer (REQUIRES REAL WINDOWS/PRINTER) gates, and `docs/E2E_V2.md` for 16 manual steps.

