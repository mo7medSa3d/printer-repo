# Documentation index

All documentation is generated from and kept in sync with the current source code. If a
document and the code ever disagree, the code wins and the document is a bug.

## Start here

| Document | What it answers |
|---|---|
| [README.md](README.md) | What the system is, repository layout, quick start, status |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flow, ownership, branch isolation |
| [INSTALLATION.md](INSTALLATION.md) | Installing the gateway, the Windows agent/desktop app and the Odoo addon |

## Reference

| Document | Scope |
|---|---|
| [API.md](API.md) | Every HTTP endpoint: auth, request, response, status codes, errors |
| [PRINTERS.md](PRINTERS.md) | Printer backends, `raw`/`escpos`/`pdf` semantics, capability enforcement, the Windows PDF pipeline, discovery |
| [docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) | `queued → claimed → printing → success/failed`, claim lease vs TTL, retries, crash behaviour |
| [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) | `print_job` / `job_ack`, ordering guarantees, delivery failure, polling fallback |
| [docs/DATABASE.md](docs/DATABASE.md) | Tables, columns, indexes, migrations |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable and configuration file |
| [docs/AGENT.md](docs/AGENT.md) | The Go agent: startup, config, delivery, execution, platform behaviour |
| [docs/ODOO.md](docs/ODOO.md) | The Odoo addon: models, configuration, report flow, sync |
| [docs/DESKTOP.md](docs/DESKTOP.md) | The Tauri desktop manager |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication domains, isolation, validation, command/file safety |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Visual identity and UI tokens (web, desktop, Odoo skin) |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Working on the code: toolchain, local setup, simulator, repo layout, how to add a route/column/backend, conventions |

## Operations

| Document | Scope |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running the gateway, reverse proxy, scaling, CI/CD, release checklist |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, how to run them, and what is *not* covered |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix, using the real error strings |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | What is verified, what is open, known limitations, go/no-go checklist |
| [WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md) | Manual hardware verification procedure with a result table to fill in |

## Component-local notes

| File | Scope |
|---|---|
| [src-tauri/README.md](src-tauri/README.md) | Rust/Tauri shell layout and build |
| [odoo_addons/print_gateway/SECURITY_AUDIT.md](odoo_addons/print_gateway/SECURITY_AUDIT.md) | Historical Odoo-side security audit (see docs/SECURITY.md for the current model) |

## Verification vocabulary

Documents use these labels consistently:
**VERIFIED** (executed by automated tests here) · **SOFTWARE VERIFIED** (end-to-end but
without hardware) · **COMPILE VERIFIED** (builds/vets for the target, never executed) ·
**SIMULATED** (development stand-in) · **NOT VERIFIED** · **REQUIRES HARDWARE** ·
**REQUIRES LIVE ODOO**.

Physical printing is currently **NOT VERIFIED** — see
[docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).
