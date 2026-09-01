# Installation — Windows (Agent + Desktop) + Gateway + Odoo

## Prerequisites

- Windows 10 1809+ / Windows 11 / Server 2019+ (WebView2 Evergreen Runtime — see below)
- Administrator for `sc` service install and `C:\ProgramData` ACLs
- Gateway reachable via HTTPS/WSS (443) — Agent is outbound-only, no inbound
- Odoo 16+ with `sale` module (for `sale.order` report), `account`, `stock`, `purchase` optional for additional report mappings

## 1. Gateway (VPS)

```bash
DATABASE_URL=postgresql://... GATEWAY_JWT_SECRET=$(openssl rand -hex 32) \
MANAGER_USERNAME=admin MANAGER_PASSWORD_HASH=$(node -e "const{crypto}=require('crypto');const s=crypto.randomBytes(8).toString('hex');console.log(s+':'+crypto.scryptSync(process.argv[1],s,32).toString('hex'))" yourpass) \
npm install && npm run build && npm start  # server.ts on :3000 (Agent WS /api/agent/ws)
```

Applies migrations `drizzle/0000_simple_tigra.sql` → `0001_phase1_branch_foundation.sql` (branches/destinations/printer_bindings) → `0002_add_document_types.sql`. `next build` tolerates missing DB (empty shell) but runtime requires `DATABASE_URL`.

## 2. Agent startup

The installer bundles `resources\OdooPrintAgent.exe` and
`resources\odoo-agent-cli.exe`. On first launch the desktop app:

1. Ensures `C:\ProgramData\OdooPrintAgent\` exists.
2. Starts the bundled OdooPrintAgent.exe as a detached background process (no
   elevation needed for a normal user).
3. If an `OdooPrintAgent` Windows service is already installed and running,
   the desktop uses the service instead of a background process.

Optional administrator-managed service (survives reboot independently):

```powershell
# from an elevated PowerShell
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service install
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service start
sc query OdooPrintAgent
```

Runtime data prefers `C:\ProgramData\OdooPrintAgent\` and automatically falls
back to `%LOCALAPPDATA%\OdooPrintAgent\` when the current user is not elevated
and ProgramData is not writable by that user:

```text
config.yaml  — server URL, agent id, persisted secret, printer list
printers.json — discovered/manual printers (stable IDs, spooler/network/USB/IPP)
agent.db     — SQLite local delivery queue (WAL, busy_timeout=5000)
logs\agent.log (5 MiB rotation ×3, panic hook)
```

If the agent is unpaired it stays alive and waits for the desktop pairing flow;
it never writes into `C:\Program Files\Odoo Print Manager\`.

## 3. Pairing (CLI owns secret)

Gateway: `/dashboard` → create Agent → copy 6-char `AB12CD` (30m, single-use, uppercase).

Agent PC (admin):

```powershell
& "C:\Program Files\Odoo Print Manager\resources\odoo-agent-cli.exe" -pair AB12CD -server https://gateway.example.com
# Writes agent.id + secret to C:\ProgramData\OdooPrintAgent\config.yaml — secret never returned to the UI.
# Odoo Print Manager also performs this same operation from the Pair screen, so PowerShell is optional.
```

Validate: `GET /api/agents` shows `lastSeenAt` fresh, `status online`.

## 4. Printer Discovery & Registration

**Automatic (preferred):**
```powershell
odoo-agent-cli.exe printers discover  # EnumPrintersW + SetupDi USB + 9100/631 scan
odoo-agent-cli.exe printers list      # shows id, name, type, connection, protocol, spooler, IP/port, status, capabilities
```

**Manual (legacy/fallback):**
```powershell
# Network RAW 9100
odoo-agent-cli.exe printers add --name "Kitchen 9100" --type network --endpoint 192.168.1.50:9100 --protocol escpos --printer-type thermal
# Windows spooler (USB installed as Windows printer, or network share)
odoo-agent-cli.exe printers add --name "Office Laser" --type spooler --spooler-name "HP LaserJet M402" --printer-type laser
# USB with VID/PID (discovered, requires spooler queue for printing)
odoo-agent-cli.exe printers add --name "Zebra Label" --type usb --vid 0A5F --pid 014E --serial 123456 --spooler-name "Zebra GK420d"
# IPP
odoo-agent-cli.exe printers add --name "Office IPP" --type ipp --endpoint ipp://192.168.1.60/ipp/print --protocol ipp
```

Manager (`POST /api/printers` with `Cookie: mgr_session` after `POST /api/auth/manager/login`) can also create printers via Dashboard `Printers → Add` (same validation `ip:port`, `type`).

## 5. Tests

- **Connection (RPC, no job):** `POST /api/printers/:id/test-connection` → `{reachable, status, agentOnline}` (last heartbeat; Gateway cannot dial LAN).
- **Print (real job):** `POST /api/printers/:id/test-print` → `{jobId}` → `GET /api/jobs/:id` until `success` (socket write OK, NOT paper-out).

## 6. Desktop Manager (Tauri, no Python)

```powershell
# build host (Windows + Node 22 + Go 1.21+ + Rust stable + cargo install tauri-cli --version "^2"):
pwsh -File scripts/build-windows-installer.ps1
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Odoo Print Manager_1.0.0_x64-setup.exe (+ MSI)
# run installer on clean VM (no Node/Python/Go/Rust needed)
# NSIS: per-machine install, Start Menu folder "Odoo Print Manager", desktop shortcut, Add/Remove Programs uninstaller
# WebView2: downloadBootstrapper in tauri.conf.json — on VM without WebView2, installer downloads Evergreen Runtime; test on clean VM (docs/VERIFICATION.md W4)
# Manager data: C:\ProgramData\OdooPrintManager\settings.json + logs\odoo-print-manager.log (rotated at 5MB; verify icacls)
```

Tray: close → hide, Exit → `app.exit(0)`. `Start/Stop/Restart Agent` in the desktop UI invokes Rust commands that either control the Windows service or stop/start the bundled background process with `std::process` (no shell plugin).

**Desktop UI (new):** Dashboard (Agent/Gateway/Printers/Jobs/Heartbeat), Printers (table, discover, test, filter), Print Jobs (tabs pending/printing/completed/failed, retry), Settings (Gateway URL, Branch, Agent, Logging, Auto-start, theme). See `src/desktop/main.tsx`.

## 7. Odoo Addon

Install `print_gateway` (`odoo_addons/print_gateway`, depends `base,sale`, `application True`):

```bash
# Add to Odoo addons_path, then:
odoo-bin -c /etc/odoo.conf -d odoo -i print_gateway --stop-after-init
# Or upgrade:
odoo-bin -c /etc/odoo.conf -d odoo -u print_gateway --stop-after-init
```

Configuration (Odoo UI `Print Gateway` menu):
- `Print Gateway → Configuration → Branches` — set `gateway_url` + `gateway_api_key` (branch-scoped `odoo_xxx` from Gateway `POST /api/odoo/keys`), `Test Connection` (`GET /api/health`), `Sync From/To Gateway` (`POST /api/odoo/sync` idempotent)
- `Destinations` — `POS 1 (pos)`, `Kitchen (kitchen)` per branch
- `Document Types` — `receipt, invoice, label, order` (payload_hint pdf/raw/escpos)
- `Report Mappings` — **new** mapping `ir.actions.report` → `document_type` (priority `report_id > xml_id > report_name > model`, e.g., `sale.action_report_saleorder → order`, `account.account_invoices → invoice`, `stock.action_report_delivery → delivery`) + `branch, destination, gateway_enabled, payload_type, fallback_to_normal`
- `Printer Bindings` — `branch + destination + document_type → printer` with `priority` fallback
- `Print Gateway → Printers/Agents/Jobs` — synced via `cron` 2m/5m (`data/cron.xml`) or manual `Sync From Gateway`

**Standard Odoo Print flow (no custom button):** Enable `Print Gateway` on `ir.actions.report` (via `print_gateway_enabled` toggle) or via `Report Mappings`. Then user clicks normal **Print** on Sale Order / Invoice / Picking / PO / POS → `ir.actions.report.report_action` override renders PDF via `_render_qweb_pdf` → `base64` `raw` → `branch.create_print_job` → `POST /api/print/jobs` `branchId/destinationId/documentType` → Gateway routing → Agent → Printer, creates `print_gateway.print_job` with `gateway_job_id, odoo_model, odoo_record_id, report_xml_id`. Unconfigured reports fallback to normal PDF download.

**Legacy Sale Order button:** `Print via Gateway` header button removed; kept as deprecated `ir.actions.server` `Print via Gateway (Deprecated - Use standard Print)` for direct RPC backward compat (calls `sale_order.action_print_via_gateway` ESC/POS). Preferred is standard Print.

## 8. Troubleshooting

- Agent `Heartbeat rejected 401` → secret revoked, re-pair.
- Printer always offline → `Test Connection` probe + `agent.log` dial error; check LAN, port 9100/631, firewall, `ipp://` URL.
- USB `requires_spooler` → install USB printer as Windows printer, use `type spooler` with `spooler_name`.
- Desktop white screen → WebView2 missing (install Evergreen) or `gatewayUrl` not `https://`.
- `DATABASE_URL is required` at build → `next build` now succeeds without DB (empty dashboard shell); runtime needs DB.
- Report not routing → check `Report Mappings` `active` + `gateway_enabled` priority, `ir.actions.report` `print_gateway_enabled`, `branch` `enabled`, `destination` enabled, `printer` `enabled`/`status`, `Gateway` `POST /api/print/jobs` returns `NO_ROUTE`/`PRINTER_OFFLINE`/`CAPABILITY_MISMATCH`.
