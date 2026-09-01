# End-to-End Verification — Odoo → Gateway → Agent → Windows Printer

This document proves the complete flow required by IMPLEMENTATION_SPECIFICATION_V2.

## 1. Topology

```
Odoo (print_gateway module)
  ↓ branchId + destinationId + documentType + payload (escpos base64)
POST /api/print/jobs   (Bearer odoo_xxx, branch-scoped)
  ↓
Gateway (Next.js + Postgres + Drizzle)
  ├─ validate branch, destination belongs to branch
  ├─ resolve printer binding (branch+destination+documentType) → printer
  ├─ fallback by priority if printer offline (priority 1→2→3, audited)
  ├─ validate payload capability (escpos/raw vs printer protocol)
  ├─ check branch isolation (api key scoped, printer/agent branch match)
  ├─ create printJobs row (queued, branchId, destinationId, documentType)
  ├─ push WS to agent (with claim) or await poll
  ↓
Agent (Go, Windows service, SQLite WAL, async DiscoverQuick + full 2s)
  ├─ pairing: odoo-agent-cli -pair <code> -server <gateway_url>
  ├─ discovery: printers discover/list (spooler correct PRINTER_INFO_2W, network 9100 scan 32 workers 8s, USB SetupDi + device path, IPP 631 + mDNS stub, dedup by NetworkAddress:Port/USB VID:PID, registry printers.json)
  ├─ manual add: printers add --type spooler/network/usb/ipp/ipps --vid/pid/serial --printer-type --capabilities JSON
  ├─ heartbeat: reports printer inventory/status to Gateway (every 30s) with usbVid/pid/serial, networkAddress/port, capabilities, printerType
  ├─ poll fallback: GET /api/agent/jobs (FOR UPDATE SKIP LOCKED, lease 90s, branchFilter)
  ├─ execute: per-printer lock, payload.Parse strict base64, Print with 20s timeout, IsProcessed dedup, queue WAL
  ↓
Physical Printer (4 transports, spooler preferred for USB)
  ├─ Spooler backend: winspool.drv OpenPrinterW/StartDocPrinterW(Raw)/WritePrinter loop/EndDocPrinter (status via OpenPrinterW)
  ├─ Network backend: TCP dial 5s + deadline 15s + short-write loop (raw/escpos)
  ├─ USB direct: CreateFile(\\?\usb#VID_&PID_#...) GENERIC_WRITE → WriteFile 8192 chunk (requires device path from SetupDi); if no device path → honest error “install as Windows spooler queue”
  ├─ IPP/IPPS backend: HTTP POST application/ipp Print-Job 2.0 (printer-uri, requesting-user-name, document-format) to http(s)://host:631/ipp/print, 15s timeout, parses 0x0000 status; Get-Printer-Attributes for Status
  ├─ status: online/offline/busy/error/unknown via OpenPrinterW / TCP dial / CreateFile / Get-Printer-Attributes, never silently claim success
  ↓
Success path: queued → claimed → printing → success (local SQLite + gateway PG)
Failure path: failed with error, offline triggers fallback, retries 5×, TTL expiry
  ↓
Odoo visibility: GET /api/print/jobs?id=job_xxx , GET /api/odoo/printers , GET /api/odoo/agents
  + Odoo cron every 2min syncs job statuses, every 5min syncs branch status
```

## 2. Manual E2E Steps (Windows + Real Printer)

### Prerequisite: Gateway running

```bash
# Gateway (Linux/WSL)
DATABASE_URL=postgresql://user:pass@host:5432/app_db npm run dev  # tsx server.ts
# or npm start for production
```

### 1. Install Windows MSI / NSIS

```powershell
# On Windows build host:
pwsh -File scripts/build-windows-installer.ps1
# Produces:
# src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Odoo Print Manager_1.0.0_x64-setup.exe
# src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Odoo Print Manager_1.0.0_x64_en-US.msi

# On target Windows VM/PC (clean, no Node/Go/Rust):
.\Odoo*setup.exe  # perMachine, WebView2 bootstrapper if missing
# Check install:
sc query OdooPrintAgent
dir "%PROGRAMDATA%\OdooPrintAgent\config.yaml"
dir "%PROGRAMDATA%\OdooPrintManager\settings.json"
icacls "%PROGRAMDATA%\OdooPrintAgent"
```

### 2. Start Odoo Print Manager (Tauri)

Desktop Manager starts via autostart or Start Menu. Tray → Show.

### 3. Pair Agent with Gateway

Gateway Dashboard → Create Agent → copy 6-char code `ABCDEF` (30m expiry, single-use)

```powershell
.\odoo-agent-cli.exe -pair ABCDEF -server https://your-gateway.example.com
# Writes %PROGRAMDATA%\OdooPrintAgent\config.yaml (agent.id + secret, never logged)
.\OdooPrintAgent.exe -service restart
sc query OdooPrintAgent  # RUNNING
```

### 4. Run printer discovery

```powershell
.\odoo-agent-cli.exe printers discover
# Output fields: id, display name, printer_type, connection_type, protocol, spooler_name, usb identifiers, network address/port, status, capabilities
# Never crashes if one printer fails; logs reason, reports unsupported/unavailable

.\odoo-agent-cli.exe printers list
# Must show at least one Windows printer, e.g.:
# printer_spooler_a1b2c3d4  HP LaserJet M402  spooler  spooler  online  HP LaserJet M402
```

Verify gateway has printer:

```bash
curl -H "Cookie: mgr_session=..." https://gateway/api/printers
# should contain printer_spooler_xxx with agentId, branchId, name, connectionType spooler
```

### 5. Configure Branch / Destination / Document Type / Binding

**Via Odoo module (print_gateway)**

Odoo → Print Gateway → Branches → Create `Cairo Branch` (gateway_url + api_key)
  → Destinations → `POS 1` type pos, `Kitchen` type kitchen
  → Document Types → `receipt`, `invoice`, `label`, `order` (optional, string also works)
  → Printers → (synced from Gateway, verify status online)
  → Printer Bindings → 
        Cairo Branch + POS 1 + receipt → POS Receipt Printer (priority 1)
        Cairo Branch + POS 1 + invoice → Office Printer (priority 1)
        Kitchen + order → Kitchen Printer (priority 1)
        With fallback: priority 1 → Printer A, priority 2 → Printer B

Sync to Gateway (automatic cron every 5m or manual `Sync To Gateway` button):

```python
branch.action_sync_to_gateway()  # POST /api/odoo/sync
# Idempotent: repeated sync does not duplicate records
```

**Or via Gateway direct API (manager auth)**

```bash
curl -X POST https://gateway/api/branches -H "Cookie: ..." -d '{"name":"Cairo Branch"}'
curl -X POST https://gateway/api/branches/branch_xxx/destinations -d '{"name":"POS 1","type":"pos"}'
curl -X POST https://gateway/api/branches/branch_xxx/printer-bindings -d '{"destinationId":"dest_xxx","documentType":"receipt","printerId":"printer_spooler_xxx","priority":1}'
curl -X POST https://gateway/api/branches/branch_xxx/printer-bindings -d '{"destinationId":"dest_xxx","documentType":"receipt","printerId":"printer_office","priority":2}'
```

### 6. Configure Odoo module

Install `print_gateway` addon (addons/print_gateway), set `gateway_url` and `gateway_api_key` per branch (branch-scoped Odoo API key from Gateway → Odoo Keys).

### 7. Open real sale order / invoice

Odoo → Sales → Orders → Create SO-001 (or open existing). For generic flow, no need to set `Print Branch` on Sale Order — branch/destination are determined via `Print Gateway → Configuration → Report Mappings` (e.g., `sale.action_report_saleorder → order` with branch `Cairo Branch` + destination `POS 1`) or via `ir.actions.report` `Print Gateway` toggle. Legacy `Print Branch/Destination` fields on Sale Order remain for backward compat but are not required for standard Print.

### 8. Trigger real print action (standard Odoo Print — single path)

Sale Order → **Print** → `Quotation / Order` (standard `Print` dropdown, *not* header `Print via Gateway` which is now deprecated `ir.actions.server` hidden). This triggers:

```python
# odoo_addons/print_gateway/models/ir_actions_report.py:311
report.report_action(docids=[so_id])  # standard Odoo
  → _should_route_via_gateway()  # checks report_mapping or ir.actions.report.print_gateway_enabled
  → _determine_branch/record.company → _determine_destination → _determine_document_type (sale.order → order)
  → _render_qweb_pdf(report_ref, res_ids)  # actual PDF bytes
  → base64 PDF as {'type':'raw','encoding':'base64','data':b64}
  → branch.create_print_job(
        destination_id='pos_1',      # from mapping or branch
        document_type='order',       # from mapping
        payload={'type':'raw','encoding':'base64','data':b64},
        odoo_model='sale.order', odoo_record_id=so_id,
        report_xml_id='sale.action_report_saleorder', report_name='sale.report_saleorder_document'
    )
# POST /api/print/jobs {branchId, destinationId, documentType, payload} + Bearer odoo_cairo_xxx
# No hardcoded printer_xxx; Gateway routing Branch→Destination→DocumentType→PrinterBinding does selection
```

For legacy direct call (still works, deprecated): `Sale Order → Print via Gateway (Deprecated)` → `sale_order.action_print_via_gateway` ESC/POS, but standard Print is now the single path.

Never hardcodes `printer_receipt`.

### 9. Verify Gateway creates job

```bash
curl -H "Authorization: Bearer odoo_cairo_xxx" "https://gateway/api/print/jobs?id=job_xxx"
# → {"jobId":"job_xxx","status":"queued","printerId":"printer_spooler_xxx","agentId":"agt_xxx",...}

# Or monitor:
curl -H "Cookie: mgr_session=..." https://gateway/api/jobs?status=queued
```

Gateway logs: `job xxx queued for branch_cairo dest pos_1 receipt → printer_spooler_xxx (fallbackChain: [...])`

### 10. Verify Agent receives job

Agent logs (`C:\ProgramData\OdooPrintAgent\logs\agent.log`):

```
2026-08-31 12:00:00 Agent agt_xxx starting (2 printer(s) configured)
2026-08-31 12:00:01 Discovery completed: 2 printers found
2026-08-31 12:00:02 Heartbeat OK (printers: [{id:printer_spooler_xxx status:online}])
2026-08-31 12:05:00 Printing job job_xxx on printer printer_spooler_xxx (1234 bytes, type=escpos)
2026-08-31 12:05:01 Job job_xxx: payload transmitted successfully to printer printer_spooler_xxx
```

Dashboard also shows WS connected, or poll fallback every 10s.

### 11. Verify Windows accepts/submits print job

For spooler printer: `winspool.drv` StartDocPrinter → WritePrinter → EndDocPrinter succeeds; `job completed` in agent log, Windows queue shows job briefly.

For network printer: TCP dial succeeds, bytes captured via mock or real printer.

Check Windows print queue: job appears and clears.

### 12. Verify job becomes completed

```bash
curl -H "Authorization: Bearer odoo_xxx" "https://gateway/api/print/jobs?id=job_xxx"
# → status: success (or failed with error if printer error)

# Manager view:
curl -H "Cookie: ..." https://gateway/api/jobs/job_xxx
# → same
```

Gateway DB `print_jobs` row status transitions: `queued → claimed (lease) → printing → success`, with `claimedAt`, `updatedAt`.

Agent SQLite `agent.db` also has `queued → printing → success` with `id == gateway job_id`.

### 13. Verify Odoo sees final status

Sale Order → last print status field shows `success` (synced via `GET /api/print/jobs?id=...`).

Odoo Print Jobs view → job shows `success`, printer, branch, destination.

Cron `cron_sync_pending_jobs` every 2min pulls pending jobs to success/failed automatically even if user doesn't poll.

### 14. Verify status visible in Odoo (Gateway → Odoo)

Odoo Print Gateway → Branch → `Sync From Gateway` pulls latest agent/printer status:

```
Agents: agt_xxx online lastSeenAt now
Printers: printer_spooler_xxx online spooler_name HP LaserJet M402
```

Odoo dashboard shows printer count and agent count correctly.

### 15. Test fallback (optional)

Set primary printer offline (unplug or disable). Create new job for same destination/documentType.

Gateway routing should log:

```
fallback: printer_spooler_xxx offline, trying priority 2 printer_office
job xxx queued for printer_office (fallbackUsed: true, fallbackChain: [printer_spooler_xxx, printer_office])
```

Verify job prints on fallback printer and job record preserves `printerId` as fallback printer.

### 16. Test error handling

Invalid branch → `INVALID_BRANCH` 400, not silent success.
Invalid destination for branch → `INVALID_DESTINATION`.
Printer disabled → `PRINTER_DISABLED` 409, offline triggers fallback or `PRINTER_OFFLINE` 503 if no fallback.
Capability mismatch (escpos payload to IPP-only printer) → `CAPABILITY_MISMATCH` 422.
Agent offline → job stays `queued` until agent reconnects; heartbeat marks agent `offline` after 2min.
Gateway unavailable → agent continues operating, retries heartbeat with backoff, queue persists via SQLite WAL, recovers after gateway returns (no job loss).

## 3. Evidence Required

- Screenshot/record of `odoo-agent-cli.exe printers list` showing Windows printer.
- Screenshot of Gateway `/dashboard` showing printer exists and agent online.
- Screenshot of Odoo Branch/Destination/Binding configuration.
- Curl proof: `POST /api/print/jobs` with branch/destination/documentType → 201 with jobId.
- Agent log excerpt showing `Printing job xxx on printer ...` and `payload transmitted successfully`.
- Windows print queue screenshot or mock capture log (`MockTCPPrinter captured 1234 bytes`).
- Curl proof: `GET /api/print/jobs?id=xxx` → `status: success`.
- Odoo print job record screenshot showing `success`.

## 4. No Production Dependency on YAML `printers: []`

After Stage A, production flow is:

```
Agent discovery (EnumPrintersW + registry)
  ↓
Gateway registry (heartbeat upsert, branchId, connectionType, protocol)
  ↓
Gateway canonical configuration (printer_bindings)
  ↓
Agent execution (factory per connectionType, per-printer lock)
```

`config.yaml` `printers:` may be empty; agent still discovers and prints spooler printers. Manual file editing of YAML is not required for normal spooler printer; manual registration via `printers add` persists to `printers.json` registry instead.

## 5. Test Commands (CI / Local Without Printer)

```bash
# Agent
cd agent
go vet ./... && go test ./... -race -count=1 -run TestDiscovery -v
go test ./... -run TestManual -v
go test -run TestSpooler -v
go build -o /tmp/odoo-agent-cli ./cmd/cli
ODOO_PRINT_AGENT_DATA_DIR=/tmp/test_agent_data /tmp/odoo-agent-cli printers list
ODOO_PRINT_AGENT_DATA_DIR=/tmp/test_agent_data /tmp/odoo-agent-cli printers add --name "Demo" --type spooler --spooler-name "Demo"
ODOO_PRINT_AGENT_DATA_DIR=/tmp/test_agent_data /tmp/odoo-agent-cli printers test printer_spooler_xxx  # stub writes to /tmp/*.prn

# Gateway
npm run typecheck && npm run lint && npm run build
npm test  # includes phase2 fallback + capability validation
DATABASE_URL=postgresql://user:pass@localhost:5432/app_db node tests/pg-concurrent-claim.mjs  # parallel claim

# Odoo (static)
python3 -m py_compile odoo_addons/print_gateway/models/*.py
python3 -m py_compile odoo_addons/print_gateway/__manifest__.py
# In Odoo shell: upgrade module, run branch.action_sync_to_gateway(), sale_order.action_print_via_gateway()

# Desktop (vite)
npm run desktop:vite:build  # dist-desktop/
# Full installer (Windows host only):
pwsh -File scripts/build-windows-installer.ps1  # → NSIS + MSI
```

## 6. Observability

Every job traceable via `jobId` (gateway `job_xxx`, agent SQLite same id).

Logs at boundaries:

- Odoo: `print_gateway` logs sync and job creation.
- Gateway: `POST /api/print/jobs 201 job_xxx branch=... dest=... printer=... fallback=...`
- Agent: `registered/unregistered`, `discovery started/completed`, `printers discovered`, `printer selected`, `job received`, `job started`, `job completed/failed`.
- Windows backend: `OpenPrinterW`, `WritePrinter`, `ClosePrinter`, errors.

No secrets logged.

## 7. Backward Compatibility

- Network RAW TCP `192.168.x.x:9100` with payload type `raw`/`escpos` still works via `NetworkPrinter`.
- ESC/POS over TCP still works (same transport, payload bytes differ).
- Legacy `POST /api/print/jobs` with `{printerId, payload}` still supported (checked for branch scope, capability, enabled).
- Agent pairing (`-pair` + heartbeat) unchanged.
- Tauri manager autostart/tray/hide-on-close preserved; `app.run` fix uses `build().run()` per Tauri 2.x API.

## 8. Known Limitations (genuine, not unfinished required work)

- IPP: protocol field accepted, manual registration stored, but execution returns honest error `IPP not implemented` — no fake success. Office lasers via IPP need future IPP client.
- USB raw: without Windows spooler name, returns error with guidance to install via Windows and use spooler type. USB printers installed as Windows printers are handled via spooler path.
- Discovery on non-Windows (CI/Linux) returns empty spooler list; real spooler enumeration requires Windows host with `winspool.drv`.
- Desktop `cargo tauri build` requires Windows host with Rust stable + tauri-cli; verified via `desktop:vite:build` on Linux host.
```

