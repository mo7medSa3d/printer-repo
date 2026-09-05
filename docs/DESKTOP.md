# Desktop Manager (Tauri)

Windows tray application that installs, starts and pairs the local print agent and shows
gateway health. It never talks to a printer directly: printing always goes
Odoo/Dashboard → Gateway → Agent → printer.

Source: `src-tauri/` (Rust, Tauri 2) and `src/desktop/` (React + Vite, shares the design
system in `src/app/globals.css` and the primitives in `src/components/ui.tsx`).

> Status: the WebView bundle builds on any platform (`npm run desktop:vite:build`,
> **VERIFIED** here). The Rust build, the MSI/NSIS packaging, installation and the smoke
> test run only on Windows CI — **REQUIRES WINDOWS**, not executed in this Linux workspace.

## 1. Installation and startup

* Installed per-machine from the MSI or NSIS EXE produced by
  `.github/workflows/build-windows.yml` (or `scripts/build-windows-installer.ps1`).
* Bundled resources: `resources/OdooPrintAgent.exe`, `resources/odoo-agent-cli.exe`.
* Window: 1200×800, centred, background `#F8FAFC`; closing hides to the tray, **Exit** in the
  tray menu really exits (`src-tauri/src/tray.rs`).
* Optional autostart via `tauri-plugin-autostart` (toggle in Settings).
* Settings live in `%PROGRAMDATA%\OdooPrintManager\settings.json`; logs in the same folder.

## 2. UI

`src/desktop/main.tsx` — five pages, hash-routed:

| Page | Contents |
|---|---|
| **Overview** | Local agent state, gateway reachability, "needs attention" list |
| **Printers** | Discovered/registered printers, discovery, test print, manual registration (spooler / network / USB) |
| **Print Jobs** | Queue view with tabs (all / pending / printing / completed / failed) |
| **Agents** | This PC's agent. Fleet inventory is not read from unauthenticated `/api/health`. |
| **Settings** | Gateway URL, pairing, agent service control, autostart, runtime paths, app version |

## 3. Gateway connection

* The gateway URL is validated before it is stored (`normalizeGatewayUrl`): `https://` only,
  no whitespace, no embedded credentials, no query string or fragment.
* `GET /api/health` — unauthenticated, 8-second abort timeout; drives the "gateway
  connected" state. Response is `{ok:true}` / `{ok:false}` only.
* `GET /api/jobs?limit=50` — **requires a manager session**. The desktop app has no session
  of its own, so this returns 401 until the user signs in at the gateway dashboard; the UI
  surfaces that instead of hiding it.
* There is no WebSocket in the desktop app; everything is polling.

## 4. Tauri commands (Rust ↔ WebView)

Registered in `src-tauri/src/main.rs`, typed wrappers in `src/desktop/lib/ipc.ts`:

| Command | Purpose |
|---|---|
| `get_agent_status` | Service/process state, version, hostname, note |
| `start_agent` / `stop_agent` / `restart_agent` | Control the bundled agent (service when installed, otherwise a detached process) |
| `control_service` | Explicit `install/uninstall/start/stop/restart` on the Windows service |
| `pair_agent` | Runs the pairing flow with `{code, gateway_url}` |
| `get_gateway_config` / `set_gateway_config` | Read/write the stored gateway URL |
| `get_runtime_paths` | Manager data, settings file, agent config, logs, agent data |
| `get_app_version` | Bundle version |
| `get_printers` / `discover_printers` / `test_printer` / `register_printer` | Local printer operations through `odoo-agent-cli.exe` |
| `get_autostart` / `set_autostart` | Login autostart |

Long-running work is dispatched through `run_blocking` so the UI thread is never blocked.
Tray events (`tray:navigate`, `tray:restart_agent`) are delivered to the WebView as Tauri
events.

## 5. Relationship to the Go agent

* The desktop app is a **manager**, not a printing component: it can start/stop the agent,
  pair it and query it, but jobs always flow through the gateway.
* Closing or uninstalling the desktop app does not stop an installed `OdooPrintAgent`
  service.
* Printer discovery/registration performed here writes the agent's `printers.json`; the
  gateway learns about the printers through the agent's heartbeat.

## 6. Building

```bash
npm run desktop:dev          # Vite dev server on :1420 (used by `cargo tauri dev`)
npm run desktop:vite:build   # WebView bundle into dist-desktop/
# Windows build host:
cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
# or
pwsh -File scripts/build-windows-installer.ps1
```

Artifacts: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi` and
`…/nsis/*-setup.exe`. The CI workflow additionally installs the MSI and runs
`scripts/smoke-test-windows.ps1` against the installed application.

Icons are generated from `src-tauri/icons/icon-source.svg` with
`node scripts/generate-icons.mjs`; the workflow verifies every icon listed in
`tauri.conf.json` exists and is non-empty.

## 7. Security notes

* Content Security Policy is defined in `src-tauri/tauri.conf.json`
  (`app.security.csp`); capabilities are limited to `core:default`
  (`src-tauri/capabilities/`).
* No shell plugin: service control uses `std::process` with argument vectors.
* Production gateway traffic is HTTPS/WSS only. The Go agent permits HTTP only when
  both `ODOO_PRINT_AGENT_ENV=development` and `ODOO_PRINT_AGENT_ALLOW_INSECURE_HTTP=1`
  are explicitly set.
* The gateway URL validation above prevents credential-carrying URLs from being stored.

## 8. Pairing contract

The Gateway, Go agent and Tauri manager use one pairing contract: six characters from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, excluding ambiguous `O`, `I`, `0` and `1`.
Pairing codes expire after 30 minutes and are consumed atomically by the registration
endpoint. Example: `AB12CD`.
