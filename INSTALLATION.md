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

## 2. Agent Service

On clean Windows with Go 1.21+ built exes:

```powershell
# copy beside installer or from build:
mkdir "C:\Program Files\OdooPrintAgent"
copy OdooPrintAgent.exe "C:\Program Files\OdooPrintAgent\"
copy odoo-agent-cli.exe "C:\Program Files\OdooPrintAgent\"
.\OdooPrintAgent.exe -service install   # creates service OdooPrintAgent, Arguments: -config C:\ProgramData\OdooPrintAgent\config.yaml, Dependencies: Tcpip
.\OdooPrintAgent.exe -service start
sc query OdooPrintAgent
# config: C:\ProgramData\OdooPrintAgent\config.yaml (installer mkdir SYSTEM:F Administrators:F ServiceSID:F, verify: icacls "C:\ProgramData\OdooPrintAgent")
# db:     C:\ProgramData\OdooPrintAgent\agent.db (WAL, busy_timeout=5000)
```

Service restarts via SCM on failure; close Desktop does NOT stop it (`docs/VERIFICATION.md` W6).

## 3. Pairing (CLI owns secret)

Gateway: `/dashboard` → create Agent → copy 6-char `AB12CD` (30m, single-use, uppercase).

Agent PC (admin):

```powershell
& "C:\Program Files\OdooPrintAgent\odoo-agent-cli.exe" -pair AB12CD -server https://gateway.example.com
# writes agent.id + secret to C:\ProgramData\OdooPrintAgent\config.yaml — secret never returned to UI
 Restart-Service OdooPrintAgent
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
# build host (Windows + Rust stable + cargo install tauri-cli --version "^2"):
npm run desktop:vite:build
cargo tauri build  # → src-tauri/target/release/bundle/nsis/OdooPrintManager_*_x64-setup.exe
# run installer on clean VM (no Node/Python/Go/Rust needed)
# WebView2: downloadBootstrapper in tauri.conf.json — on VM without WebView2, installer downloads Evergreen Runtime; test on clean VM (docs/VERIFICATION.md W4)
# Manager data: C:\ProgramData\OdooPrintManager\settings.json (verify icacls)
```

Tray: close → hide, Exit → `app.exit(0)`. Service controls via allowlisted `OdooPrintAgent.exe -service {start,stop,restart}` args only.

## 7. Odoo

Create key: `POST /api/odoo/keys` (manager) → `odoo_...` show once. Then `POST /api/print/jobs` with that key (see README).

## Troubleshooting

- Agent `Heartbeat rejected 401` → secret revoked, re-pair.
- Printer always offline → `Test Connection` probe + `agent.log` dial error; check LAN, port 9100, firewall.
- Desktop white screen → WebView2 missing (install Evergreen) or `gatewayUrl` not `https://`.
- `DATABASE_URL is required` at build → `next build` now succeeds without DB (empty dashboard shell); runtime needs DB.
