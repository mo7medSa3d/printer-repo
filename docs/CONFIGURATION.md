# Configuration reference

Every value below exists in the code. Nothing here contains a real secret.

## 1. Gateway (Next.js) — environment variables

Template: `.env.example` (copy to `.env` for local development; inject through your process
manager or secret store in production — `.env` is git-ignored).

| Variable | Required | Used in | Meaning |
|---|---|---|---|
| `DATABASE_URL` | **Yes** (runtime) | `src/db/index.ts`, `drizzle.config.ts` | PostgreSQL connection string. Missing at build time is tolerated (`next build` collects static metadata with a dummy pool that throws on use); missing at runtime makes every query fail |
| `GATEWAY_JWT_SECRET` | **Yes** | `src/lib/manager-auth.ts` | HMAC secret for manager session JWTs, **≥ 32 characters**. Signing refuses to run with a shorter/absent value. Generate with `openssl rand -hex 32` |
| `MANAGER_USERNAME` | **Yes** | `src/lib/manager-auth.ts` | Dashboard username. Without it, login returns HTTP 500 (fails closed) |
| `MANAGER_PASSWORD` | one of the two | `src/lib/manager-auth.ts` | Plaintext password (development) |
| `MANAGER_PASSWORD_HASH` | one of the two | `src/lib/manager-auth.ts` | Preferred in production: scrypt `salt:derived-hex` |
| `PORT` | No (default `3000`) | `server.ts` | HTTP + WebSocket port |
| `HOSTNAME` | No (default `0.0.0.0`) | `server.ts` | Bind address |
| `NODE_ENV` | No | `server.ts`, `src/db/index.ts` | `production` disables the dev connection-pool cache and Next dev mode |

No other `process.env.*` reads exist in `src/`, `server.ts` or `scripts/`.

Generate a password hash:

```bash
node -e "const c=require('crypto');const s=c.randomBytes(8).toString('hex');console.log(s+':'+c.scryptSync(process.argv[1],s,32).toString('hex'))" 'your-password'
```

## 2. Agent (Go) — `config.yaml`

Location (in priority order, `agent/internal/config/config.go`):
`ODOO_PRINT_AGENT_DATA_DIR` → `%PROGRAMDATA%\OdooPrintAgent` →
`%LOCALAPPDATA%\OdooPrintAgent` → the executable's directory.

```yaml
server:
  url: https://gateway.example.com

agent:
  id: agt_7f3c                # written by pairing
  secret: "…"                 # written by pairing (DPAPI-sealed on Windows)
  name: "POS PC 1"
  pdf_print_command: []       # optional PDF helper, argv form, {printer} and {file}
  reprint_after_crash: true   # optional, default true

printers: []                  # optional/legacy; printers.json is canonical
```

| Key | Default | Meaning |
|---|---|---|
| `server.url` | – | Gateway base URL. Validated (`Validate()`), no trailing slash needed |
| `agent.id` / `agent.secret` | – | Credentials from pairing; sent as `Bearer <id>:<secret>` |
| `agent.name` | host name | Shown in the dashboard |
| `agent.pdf_print_command` | unset | External PDF helper executed **without a shell**; `{printer}` and `{file}` are whole argv elements. When unset, Windows uses the registered PDF handler (`ShellExecuteExW printto`); other platforms return an explicit "not supported" error |
| `agent.reprint_after_crash` | `true` | May a job that was interrupted mid-print be printed again on re-delivery? `true` = at-least-once (may duplicate paper), `false` = never reprint automatically. Neither is exactly-once |
| `printers[]` | `[]` | Legacy static printer list: `id, name, type, endpoint, protocol, spooler_name, printer_type, usb_vid, usb_pid, usb_serial, enabled, capabilities` |

Per-printer `capabilities.supported_protocols` overrides what the agent would otherwise
report automatically; the gateway treats an explicit list as authoritative.

Agent environment variables:

| Variable | Meaning |
|---|---|
| `ODOO_PRINT_AGENT_DATA_DIR` | Overrides the whole runtime directory (config, `agent.db`, `printers.json`, `logs/`) |
| `RUN_PHYSICAL_PRINTER_TESTS` | Opt-in for hardware-dependent Go tests (skipped unless set) |

## 3. Desktop manager (Tauri)

| Item | Value |
|---|---|
| Settings file | `%PROGRAMDATA%\OdooPrintManager\settings.json` (override with `ODOO_PRINT_MANAGER_DATA_DIR`) |
| Stored settings | Gateway URL (validated: `http(s)://`, no credentials/query/fragment) |
| Bundled resources | `resources/OdooPrintAgent.exe`, `resources/odoo-agent-cli.exe` (`src-tauri/tauri.conf.json`) |
| Window | 1200×800, background `#F8FAFC`, tray icon, hide-on-close |
| CSP | Defined in `tauri.conf.json` (`app.security.csp`) |
| Installer | NSIS (per-machine) + MSI, WebView2 `downloadBootstrapper` |

## 4. Odoo addon

Configured through the Odoo UI, not files:

| Field | Model | Meaning |
|---|---|---|
| `gateway_url` | `print_gateway.branch` | Gateway base URL for this branch |
| `gateway_api_key` | `print_gateway.branch` | Branch-scoped `odoo_…` key (password field, system group only) |
| `gateway_branch_id` / `gateway_destination_id` / `gateway_document_type_id` / `gateway_printer_id` / `gateway_agent_id` | various | Ids as stored in the gateway when they differ from Odoo record ids |
| `payload_type` | `print_gateway.report_mapping` | `pdf` (default) · `raw` (legacy) · `escpos` (requires pre-formatted ESC/POS) |
| Crons | `data/cron.xml` | Job status sync 2 min, branch pull 5 min, config push 5 min |

## 5. Build / CI configuration

| File | Purpose |
|---|---|
| `package.json` | Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch`, `db:push`, `db:generate`, `db:studio`, `desktop:dev`, `desktop:vite:build`, `desktop:build` |
| `.nvmrc` / `.node-version` | Node version used by CI and local development (Node ≥ 22 is required by `engines`) |
| `vitest.config.ts` | Test include pattern `tests/**/*.test.ts`, `@` → `src` alias |
| `drizzle.config.ts` | Drizzle Kit: dialect, schema path, `DATABASE_URL` |
| `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` | Framework configuration |
| `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/` | Desktop bundle, permissions |
| `.github/workflows/build-windows.yml` | Windows CI: typecheck, lint, vitest, `go vet`, `go test`, `go test -race`, Go builds, Tauri MSI+NSIS build, MSI install + smoke test, artifact upload |
| `scripts/` | `build-windows-installer.ps1`, `smoke-test-windows.ps1`, `generate-icons.mjs`, `pg-concurrent-claim.sh` |

## 6. Ports and network

| Port | Component |
|---|---|
| `3000` (configurable) | Gateway HTTP + `/api/agent/ws` WebSocket (same port) |
| `1420` | Vite dev server for the desktop UI (`npm run desktop:dev`) |
| `5432` | PostgreSQL (deployment-defined) |
| `9100` outbound | RAW TCP printing / discovery scan |
| `631` outbound | IPP printing / discovery scan |

The agent needs outbound HTTPS/WSS to the gateway only — no inbound ports.
