# Odoo Local Print Agent — Production Gateway

```
             ODOO CLOUD
                 │ HTTPS (Odoo API key)
                 ▼
       ┌────────────────────┐
       │ Print Gateway/API  │  Next.js 16 + PostgreSQL + Drizzle
       │ WS server (Agent)  │  server.ts + src/server/ws.ts
       └─────────┬──────────┘
                 │ WSS/HTTPS (Bearer agt:secret)
                 ▼
       ┌────────────────────┐
       │ Windows Print Agent│  Go 1.21, Windows Service, SQLite WAL
       └─────────┬──────────┘
                 │ LAN TCP 9100
                 ▼
       ┌────────────────────┐
       │ Network Printer    │  RAW TCP / ESC/POS
       └────────────────────┘

     ┌─────────────────────────────────┐
     │ Windows Desktop Manager         │  Tauri 2.x + React (polls HTTPS)
     │ Management, pairing, diagnostics│  thin, no Python, no Electron
     └──────────────┬──────────────────┘
                    │ HTTPS (manager JWT 8h)
                    ▼
              Cloud Print Gateway
```

## Quick Start

### 1. Gateway (Linux/WSL or VPS)

```bash
cp .env.example .env  # set DATABASE_URL, GATEWAY_JWT_SECRET, MANAGER_USERNAME, MANAGER_PASSWORD_HASH
npm install
npm run typecheck && npm run lint && npm run build
# dev with Agent WS on same port:
npm run dev          # tsx server.ts → http://localhost:3000  WS /api/agent/ws
# prod:
npm run build && npm start
```

### 2. Go Agent (Windows host with Go 1.21+)

```powershell
cd agent
go vet ./... && go test ./... -race -count=1
go build -o OdooPrintAgent.exe ./cmd/agent
go build -o odoo-agent-cli.exe ./cmd/cli
.\OdooPrintAgent.exe -service install
.\OdooPrintAgent.exe -service start
sc query OdooPrintAgent
# config at C:\ProgramData\OdooPrintAgent\config.yaml (least-privilege ACL)
# logs beside it / event log
```

### 3. Pair

Gateway: `GET /dashboard` → create Agent → copy 6-char code (uppercase, 30m expiry, single-use).

Agent CLI (on Windows PC):

```powershell
.\odoo-agent-cli.exe -pair ABCDEF -server https://your-gateway.example.com
# CLI writes agent.id + secret to ProgramData\OdooPrintAgent\config.yaml — secret never returned to UI
```

### 4. Add Printer

```bash
# manager login first
curl -X POST https://gateway/api/auth/manager/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' -c cookies.txt
# create network printer
curl -X POST https://gateway/api/printers -b cookies.txt -H "Content-Type: application/json" \
  -d '{"agentId":"agt_xxx","name":"Receipt","type":"network","config":{"ip":"192.168.1.50","port":9100,"protocol":"escpos"}}'
```

Or use Dashboard `Printers` → `Add`.

### 5. Test (diagnostic split)

- **Connection (no job):** `POST /api/printers/:id/test-connection` → `{reachable, status, agentOnline, probeId}` — Gateway cannot dial LAN; result is last heartbeat `printer.status` + agent online.
- **Print (real job):** `POST /api/printers/:id/test-print` → `{jobId}` → job `queued → claimed (lease, FOR UPDATE SKIP LOCKED) → printing → success/failed` (Gateway PG) vs Agent local `queued → printing → success/failed` (SQLite WAL, `id == gateway job_id`). Success = socket write OK, NOT paper-out (see PRINTERS.md).

### 6. Odoo

```bash
# create Odoo key (manager auth)
curl -X POST https://gateway/api/odoo/keys -b cookies.txt -H "Content-Type: application/json" -d '{"name":"Odoo prod"}'
# → {"apiKey":"odoo_..."}  show once

# Odoo creates job
curl -X POST https://gateway/api/print/jobs -H "Authorization: Bearer odoo_..." -H "Content-Type: application/json" \
  -d '{"printerId":"printer_receipt","payload":{"type":"escpos","encoding":"base64","data":"G1vdGhlciB..."},"idempotencyKey":"order-123"}'
# → {"jobId":"job_xxx","status":"queued"}
# poll:
curl -H "Authorization: Bearer odoo_..." "https://gateway/api/print/jobs?id=job_xxx"
```

### 7. Desktop Manager (Tauri 2.x, no Python)

```powershell
# One-shot production build (Windows host: Node 22+, Go 1.21+, Rust stable + tauri-cli):
pwsh -File scripts/build-windows-installer.ps1
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Odoo Print Manager_1.0.0_x64-setup.exe
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Odoo Print Manager_1.0.0_x64_en-US.msi
```

The installer bundles `dist-desktop` + the two agent EXEs as resources, installs
per-machine (NSIS), creates Start Menu + desktop shortcuts, registers an
uninstaller in Add/Remove Programs, and downloads WebView2 Evergreen if missing.
Customers need **no** Node/Go/Rust/Python.

Manual equivalent steps:

```powershell
npm ci
npm run desktop:vite:build            # dist-desktop/ (React UI)
cd agent; go build -trimpath -ldflags "-s -w" -o OdooPrintAgent.exe ./cmd/agent
          go build -trimpath -ldflags "-s -w" -o odoo-agent-cli.exe ./cmd/cli; cd ..
cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
```

Dev loop: `cargo tauri dev` (spins up the Vite dev server on :1420 automatically).

Trails: `C:\ProgramData\OdooPrintManager\settings.json` (SYSTEM:F, Administrators:F, verify icacls). Closing Desktop does NOT stop `OdooPrintAgent` service.

## Two Job Models

- **Gateway PG:** `queued → claimed (lease 90s, FOR UPDATE SKIP LOCKED, retries<5) → printing → success/failed/expired` (`src/app/api/agent/jobs/route.ts:49`, `src/lib/job-status.ts`)
- **Agent SQLite WAL:** `queued → printing → success/failed` (`agent/internal/queue/queue.go:14`, `id == gateway job_id`, `INSERT OR IGNORE` idempotency, `PRAGMA journal_mode=WAL`)

## Build & Test

```bash
npm run typecheck && npm run lint && npm run build && npm test
cd agent && go vet ./... && go test ./... -race -count=1 && go build -trimpath -ldflags "-s -w" ./...
npm run desktop:vite:build
# Full Windows installer (on a Windows build host):
pwsh -File scripts/build-windows-installer.ps1
```

See `docs/VERIFICATION.md` for CI vs Real Windows vs Real Printer gate (no production-ready claim until all green).

## Docs

- `ARCHITECTURE.md` — queues, claiming, WS, assumptions
- `API.md` — Agent vs Manager vs Odoo endpoints
- `PRINTERS.md` — RAW vs ESC/POS vs USB vs IPP, success = socket write
- `INSTALLATION.md` — Windows service + ProgramData ACLs + WebView2
- `docs/AUTH.md` — manager 8h httpOnly JWT (jti), Odoo `odoo_` keys
- `docs/VERIFICATION.md` — full gate with `VERIFIED / REQUIRES REAL WINDOWS/PRINTER TEST`
