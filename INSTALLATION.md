# Installation

Three parts, installed independently: the **Gateway** (server), the **Agent + Desktop
Manager** (each Windows PC that has printers), and the **Odoo addon**.

## Prerequisites

| Component | Requirements |
|---|---|
| Gateway | Node ≥ 22, PostgreSQL, a TLS-terminating reverse proxy for production |
| Agent PC | Windows 10 1809+ / 11 / Server 2019+, administrator rights for the service and `C:\ProgramData` ACLs, outbound HTTPS/WSS to the gateway (no inbound ports) |
| Odoo | Odoo 16/17/18 with `base, sale, account, stock, purchase, point_of_sale` |
| Build host (installer) | Windows + Node ≥ 22 + Go 1.21+ + Rust stable + `cargo install tauri-cli --version "^2"` |

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
GATEWAY_JWT_SECRET=$(openssl rand -hex 32)          # >= 32 chars
MANAGER_USERNAME=admin
MANAGER_PASSWORD_HASH=<salt:derived-hex>            # or MANAGER_PASSWORD for dev
PORT=3000
```

Create the schema by applying the migrations in order
(`drizzle/0000_simple_tigra.sql` → `0001_phase1_branch_foundation.sql` →
`0002_add_document_types.sql` → `0003_add_idempotency_key.sql` →
`0004_add_job_delivery_tracking.sql`), for example:

```bash
for f in drizzle/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
# or, for development only:
npm run db:push
```

Build and run — `server.ts` serves Next.js **and** the agent WebSocket on the same port:

```bash
npm run build
npm start            # http://0.0.0.0:3000, agent WS at /api/agent/ws
```

`next build` tolerates a missing `DATABASE_URL`; the runtime does not.

Verify: `curl -s http://localhost:3000/api/health` → `{"ok":true,…}`, then sign in at
`/login` with the manager credentials.

## 2. Windows Agent + Desktop Manager

Install the bundle produced by the `Build Windows Installer` workflow (MSI or NSIS EXE), or
build it yourself:

```powershell
pwsh -File scripts/build-windows-installer.ps1
# → src-tauri\target\x86_64-pc-windows-msvc\release\bundle\{msi\*.msi, nsis\*-setup.exe}
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
odoo-agent-cli.exe printers discover   # spooler + USB + TCP 9100 + IPP 631
odoo-agent-cli.exe printers list
odoo-agent-cli.exe printers test <printer-id>
```

Manual registration when discovery is not enough — see [PRINTERS.md](PRINTERS.md) §7.
For PDF printing the printer must be a **Windows spooler queue** (or IPP); install USB
printers as Windows printers and register them with `--type spooler --spooler-name "…"`.
Optionally configure `agent.pdf_print_command` for a deterministic PDF helper.

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

1. **Branches** — `gateway_url` + a branch-scoped API key (`POST /api/odoo/keys`),
   press *Test Connection*.
2. **Destinations** and **Document Types** for the branch.
3. *Sync From Gateway* to import agents/printers.
4. **Printer Bindings** — destination + document type → printer (with `priority`).
5. **Report Mappings** — which reports print through the gateway and as which payload type
   (`pdf` is the default for QWeb reports).
6. *Sync To Gateway* — must return success; `SYNC_DEPENDENCY_MISSING` means a referenced
   printer has not been registered by an agent yet.

Printing then uses the **standard Odoo Print button**; no custom button is required.

## 4. Upgrading

* Gateway: pull, `npm ci`, apply any new `drizzle/*.sql`, rebuild, restart.
  Migration `0004` is additive and safe to apply to a running database.
* Agent: install the new MSI/EXE (stop the service first); `config.yaml`, `printers.json`
  and `agent.db` are preserved.
* Odoo: `-u print_gateway`.

## 5. Troubleshooting

Common cases are collected in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
