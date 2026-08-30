# Installation — Windows (Agent + Desktop)

## Prerequisites

- Windows 10 1809+ / Windows 11 / Server 2019+ (WebView2 Evergreen Runtime — see below)
- Administrator for `sc` service install and `C:\ProgramData` ACLs
- Gateway reachable via HTTPS/WSS (443) — Agent is outbound-only, no inbound

## 1. Gateway (VPS)

```bash
DATABASE_URL=postgresql://... GATEWAY_JWT_SECRET=$(openssl rand -hex 32) \
MANAGER_USERNAME=admin MANAGER_PASSWORD_HASH=$(node -e "const{crypto}=require('crypto');const s=crypto.randomBytes(8).toString('hex');console.log(s+':'+crypto.scryptSync(process.argv[1],s,32).toString('hex'))" yourpass) \
npm install && npm run build && npm start  # server.ts on :3000 (Agent WS /api/agent/ws)
```

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
agent.db     — SQLite local delivery queue (WAL, busy_timeout=5000)
logs\agent.log
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

## 4. Printer

Manager (`POST /api/printers` with `Cookie: mgr_session` after `POST /api/auth/manager/login`):

```powershell
Invoke-RestMethod https://gateway/api/printers -Headers @{Cookie="mgr_session=..."} -Method POST -Body '{"agentId":"agt_xxx","name":"Receipt","type":"network","config":{"ip":"192.168.1.50","port":9100,"protocol":"escpos"}}' -ContentType "application/json"
```

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

Tray: close → hide, Exit → `app.exit(0)`. `Start/Stop/Restart Agent` in the desktop UI invokes Rust commands that either control the Windows service or stop/start the bundled background process with `std::process` (no shell plugin, no arbitrary command execution).

## 7. Odoo

Create key: `POST /api/odoo/keys` (manager) → `odoo_...` show once. Then `POST /api/print/jobs` with that key (see README).

## Troubleshooting

- Agent `Heartbeat rejected 401` → secret revoked, re-pair.
- Printer always offline → `Test Connection` probe + `agent.log` dial error; check LAN, port 9100, firewall.
- Desktop white screen → WebView2 missing (install Evergreen) or `gatewayUrl` not `https://`.
- `DATABASE_URL is required` at build → `next build` now succeeds without DB (empty dashboard shell); runtime needs DB.
