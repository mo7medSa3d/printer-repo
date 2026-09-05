# Installation

Three parts, installed independently: the **Gateway** (server), the **Agent + Desktop Manager** (each Windows PC that has printers), and the **Odoo addon**.

## Prerequisites

| Component | Requirements |
|---|---|
| Gateway | Node ≥ 24.20.0, PostgreSQL, and a TLS-terminating reverse proxy for production |
| Agent PC | Windows 10 1809+ / 11 / Server 2019+, administrator rights for the service and `C:\ProgramData` ACLs, outbound HTTPS/WSS to the gateway (no inbound ports) |
| Odoo | Odoo 19 Community/compatible deployment with `base` and the business modules required by the customer's reports/workflow |
| Build host (installer) | Windows + Node ≥ 24.20.0 + Go 1.27.1 + Rust + the repository's Tauri CLI workflow |

---

## 1. Gateway

```bash
git clone https://github.com/mo7medSa3d/printer-repo.git
cd printer-repo
npm ci
cp .env.example .env      # then edit
```

Minimum environment (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)):

```bash
DATABASE_URL=postgresql://user:pass@host:5432/print_gateway
GATEWAY_JWT_SECRET=$(openssl rand -hex 32)
MANAGER_USERNAME=admin
MANAGER_PASSWORD_HASH=<salt:derived-hex>
PORT=3000
```

For development, apply migrations with:

```bash
npm run db:migrate
```

For Docker production/staging deployments, use the dedicated `migrate` Compose service. Do not manually replay the historical migration list from this document.

Build and run — `server.ts` serves Next.js **and** the agent WebSocket on the same port:

```bash
npm run build
npm start
```

`next build` tolerates a missing `DATABASE_URL`; the runtime does not.

Verify: `curl -s http://localhost:3000/api/health` → `{"ok":true}`, then sign in at
`/login` with the manager credentials.

## 2. Windows Agent + Desktop Manager

Install the bundle produced by the `Build Windows Installer` workflow (MSI or NSIS EXE), or
build it yourself using the repository build script on Windows:

```powershell
pwsh -File scripts/build-windows-installer.ps1
```

The installer is per-machine and bundles `resources\OdooPrintAgent.exe` and
`resources\odoo-agent-cli.exe`; WebView2 is fetched by the bootstrapper if missing.

On first launch **Odoo Print Manager**:

1. creates `C:\ProgramData\OdooPrintAgent\` (falling back to
   `%LOCALAPPDATA%\OdooPrintAgent\` when ProgramData is not writable);
2. starts the bundled agent — as the `OdooPrintAgent` Windows service when it is installed,
   otherwise as a detached background process.

Optional explicit service installation (survives reboot, runs as LocalSystem):

```powershell
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service install
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service start
sc query OdooPrintAgent
```

Runtime files:

```text
C:\ProgramData\OdooPrintAgent\config.yaml     server URL, agent id/secret, options
C:\ProgramData\OdooPrintAgent\printers.json   discovered/manual printers (stable ids)
C:\ProgramData\OdooPrintAgent\agent.db        local SQLite queue (WAL)
C:\ProgramData\OdooPrintAgent\logs\agent.log  rotated at 5 MiB, 3 old files
C:\ProgramData\OdooPrintManager\settings.json desktop settings (gateway URL)
```

Nothing is ever written into `C:\Program Files\Odoo Print Manager\`.

### Pairing

1. Gateway dashboard → create an agent for the branch → copy the 6-character code
   (uppercase, 30 minutes, single use).
2. Either the desktop app (**Settings → Pair**) or the CLI:

```powershell
& "C:\Program Files\Odoo Print Manager\resources\odoo-agent-cli.exe" -pair AB12CD -server https://gateway.example.com
```

The secret is written to `config.yaml` (DPAPI-sealed) and never shown again.
Verify with `GET /api/agents` (manager auth): the agent is `online` with a fresh
`lastSeenAt`.

### Printers

```powershell
odoo-agent-cli.exe printers discover
odoo-agent-cli.exe printers list
odoo-agent-cli.exe printers test <printer-id>
```

Discovery candidates are observations. A Manager must approve a candidate before the Gateway provisions it. Discovery origin alone never becomes a print transport: the candidate must report an explicit executable protocol such as IPP/IPPS, RAW, LPR, ESC/POS, or Windows spooler.

Manual registration when discovery is not enough — see [PRINTERS.md](PRINTERS.md) §7.
For PDF printing the printer must be a **Windows spooler queue** (or IPP); install USB
printers as Windows printers and register them with `--type spooler --spooler-name "…"`.

### Verify

* Connection (no job): `POST /api/printers/:id/test-connection`
* Real job: `POST /api/printers/:id/test-print` → poll `GET /api/jobs/:id` until
  `success`. Success means the transport accepted the document, not that paper came out —
  the physical check is [WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md).

## 3. Odoo addon

```bash
cp -r odoo_addons/print_gateway /path/to/odoo/addons/
odoo-bin -c /etc/odoo.conf -d <db> -i print_gateway --stop-after-init
# upgrade later with -u print_gateway
```

Then, in **Print Gateway** (see [docs/ODOO.md](docs/ODOO.md) for detail):

1. **Branches** — `gateway_url` + a branch-scoped API key (`POST /api/odoo/keys`), press *Test Connection*.
2. **Destinations** and **Document Types** for the branch.
3. *Sync From Gateway* to import agents/printers.
4. **Printer Bindings** — destination + document type → printer (with `priority`).
5. **Report Mappings** — which reports print through the gateway and as which payload type (`pdf` is the default for QWeb reports).
6. *Sync To Gateway* — must return success; `SYNC_DEPENDENCY_MISSING` means a referenced printer has not been registered by an agent yet.

Printing then uses the **standard Odoo Print button**; no custom button is required.

## 4. Upgrading

* Gateway: pull, `npm ci`, run `npm run db:migrate` (or the production migration deployment), rebuild, and restart.
* Agent: install the new MSI/EXE (stop the service first); `config.yaml`, `printers.json`
  and `agent.db` are preserved.
* Odoo: `-u print_gateway`.

## 5. Troubleshooting

Common cases are collected in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
