# Odoo Print Gateway

Cloud print gateway that turns an Odoo report into a physical page on the right printer, in
the right branch, without hardcoding printer ids anywhere.

```
Odoo → print_gateway addon → Cloud Gateway (Next.js + PostgreSQL + Drizzle) → Windows Agent (Go) → printer
                                     ▲                                        │
                                     └────────── job status ◄─────────────────┘
```

* **Multi-branch by design** — routing is `branch → destination → document type → printer
  binding`, so Odoo never needs to know a physical printer id.
* **Exactly one owner per job** — a job is claimed in a database transaction *before* it is
  handed to an agent, so an agent can never execute a job the gateway still calls `queued`.
* **Honest payload types** — `raw`, `escpos` and `pdf` are distinct; a PDF is printed through
  a real PDF path or refused with `CAPABILITY_MISMATCH`, never dumped as raw bytes.
* **Recoverable delivery** — lost deliveries are requeued under the *same* job id; stale
  claims are reclaimed after a 90 s lease; duplicates are acknowledged but not reprinted.

## Repository layout

```
src/                Next.js gateway: API routes, routing, claim/delivery, dashboard
  app/api/**        route handlers (agent, manager, Odoo, health)
  lib/              payload contract, routing, job status, claim/delivery, auth
  server/ws.ts      agent WebSocket server (attached in server.ts)
  db/               Drizzle schema + connection
  desktop/          React UI of the Tauri desktop manager
drizzle/            SQL migrations + journal
agent/              Go agent + CLI (service, discovery, printing, local queue)
src-tauri/          Rust/Tauri shell for the Windows desktop manager
odoo_addons/        Odoo addon `print_gateway`
tests/              Vitest suites (unit, contract, PostgreSQL-backed, E2E)
scripts/            Windows installer, smoke test, icon generation, PG concurrency harness
docs/               Reference documentation (see DOCS.md for the index)
```

## Quick start (development)

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

Sign in at `/login` with `MANAGER_USERNAME` / `MANAGER_PASSWORD`, create a branch, create an
agent to obtain a pairing code, pair the agent, run discovery, then create a destination,
a document type and a printer binding.

The browser simulator has been removed from the production gateway. For end-to-end development
without physical hardware, use the real Go agent with the supported local/non-Windows print
simulation path described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Full instructions: [INSTALLATION.md](INSTALLATION.md) ·
configuration reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## How a print job flows

1. Odoo intercepts the report (`ir.actions.report.report_action`), resolves branch,
   destination and document type from a **report mapping**, renders the QWeb PDF and POSTs
   `{"type":"pdf","encoding":"base64","data":…}` to `POST /api/print/jobs` with a
   branch-scoped API key and an idempotency key.
2. The gateway validates the key, the document-type permission and the payload, resolves the
   printer through the binding chain (with priority fallback and a capability check), and
   inserts a `queued` job.
3. The job is claimed in one transaction (`FOR UPDATE SKIP LOCKED`) and only then delivered:
   `{"type":"print_job","job":{…,"status":"claimed"}}` over the agent WebSocket, or as the
   response of the agent's poll.
4. The agent acknowledges (`job_ack`), records the job in its local SQLite queue, reports
   `printing`, prints through the backend that matches the payload type, then reports `success`
   or `failed` with the real error.
5. Odoo polls the job status every 2 minutes; the dashboard and the desktop manager poll too.

Details: [docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) ·
[docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) · [API.md](API.md).

## Payload types and printers

| type | printed by | refused by |
|---|---|---|
| `raw` | RAW TCP :9100, Windows spooler (RAW datatype), raw USB, IPP (`application/octet-stream`) | — |
| `escpos` | same as `raw` | — |
| `pdf` | Windows spooler through the PDF pipeline, IPP (`application/pdf`) | RAW TCP and raw USB → `CAPABILITY_MISMATCH` |

The agent reports each backend's real capabilities in the heartbeat, and the gateway refuses
an incompatible job with HTTP 422 before it is ever queued. Full matrix and the PDF pipeline:
[PRINTERS.md](PRINTERS.md).

## Discovery

The Agent provides bounded, best-effort discovery detectors for configuration/registry,
Windows spooler, USB, RAW TCP, IPP/IPPS, LPR, SNMP, WSD and mDNS sources. Sources are additive
and results are deduplicated before they are reported to the Gateway.

Discovery results distinguish **candidate** from **verified** devices. Verification and
confidence are heuristic and device-dependent; discovery is not a guarantee that every printer
model, vendor protocol or network topology will be detected. Windows-only native USB/spooler
capabilities are unavailable on non-Windows hosts.

The Agent orchestrator enforces a 30-second upper bound for a discovery session and reports a
failed or cancelled session when that bound is exceeded. Individual network detectors also use
shorter bounded timeouts. The orchestration timeout is a safety boundary; detector-specific
cancellation remains dependent on each detector's own context support.

## Tests

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm test
npm run build
cd agent && go build ./... && go vet ./... && go test ./... && go test -race ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
```

PostgreSQL-backed suites require `DATABASE_URL` and are a required CI gate. The CI schema
invariant guard fails closed. Odoo, Windows, network-printer and USB-printer E2E remain
environment-dependent and are not represented as passing unless that environment actually ran.

## Build and deployment

```bash
npm run build
npm run desktop:vite:build
pwsh -File scripts/build-windows-installer.ps1
```

`.github/workflows/build-windows.yml` builds the installers and smoke-tests them on Windows.
Server deployment, reverse-proxy requirements and the release checklist are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

[DOCS.md](DOCS.md) is the index. Direct links: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[API.md](API.md) · [PRINTERS.md](PRINTERS.md) · [INSTALLATION.md](INSTALLATION.md) ·
[docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) · [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) ·
[docs/AGENT.md](docs/AGENT.md) · [docs/ODOO.md](docs/ODOO.md) · [docs/DESKTOP.md](docs/DESKTOP.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/DATABASE.md](docs/DATABASE.md) ·
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · [docs/CONFIGURATION.md](docs/CONFIGURATION.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ·
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) · [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) ·
[WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md) · [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## Known limitations

1. **Printing is at-least-once, never exactly-once.** A crash while a document is at the printer
   leaves an unknown physical outcome; the agent reports it explicitly
   (`AGENT_RESTART_DURING_PRINT`) and `agent.reprint_after_crash` decides whether it may be
   printed again.
2. **"Success" means transport acceptance**, not guaranteed paper output.
3. `POST /api/printers/:id/test-connection` returns cached heartbeat data; there is no live
   probe.
4. **Discovery is best-effort.** mDNS, SNMP and WSD are bounded detectors, but protocol/vendor
   coverage is not certified across every device family and environment.
5. WebSocket push is per gateway process; with multiple instances an agent connected to another
   instance receives the job through polling (≤ 10 s).
6. Manager authentication is a single global role; Odoo keys are the branch-scoped ones.
7. PDF printing outside Windows requires an explicit `pdf_print_command`; the non-Windows
   spooler backend reports unsupported operation without a configured helper.

## Production architecture and ownership

Odoo is the business/configuration source of truth. The Gateway is the runtime authority for
registered Agents, runtime Printers, heartbeat/availability, print Jobs, and execution state.

The authoritative runtime hierarchy is **Branch → Agent → Printer**. A Gateway Printer has no
independent Branch ownership field; branch is derived through `printer.agentId → agent.branchId`.

Agent and Printer deletion is lifecycle-based: `active <-> disabled`, `active/disabled -> retired`;
`retired` is terminal. Normal API/UI flows never physically delete Agents or Printers, so
historical jobs and audit relationships survive. The manager UI now also exposes a guarded hard
Delete action for an offline Agent that has no Printers, no print history, and no remaining
operational discovery records.

Logical print requests are idempotent by UUID/idempotency key. Physical printing remains
potentially at-least-once because a device may receive bytes before a network failure is observed;
exactly-once physical printing is not claimed.

PostgreSQL-backed integration tests are a required CI gate. Odoo, Windows, network-printer and
USB-printer E2E are environment-dependent and are not represented as passing unless that
environment actually ran.

## Production Engineering Semantics

- **Odoo print outbox:** report actions persist the logical operation and idempotency key inside
  the Odoo transaction. Gateway submission is registered as a post-commit job; a process crash
  before submission leaves the durable queued operation for the retry cron.
- **Metrics:** manager-authenticated `GET /api/metrics` exposes process-local Prometheus counters;
  logs remain the authoritative event stream and never contain payload bytes or credentials.
- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation.
  Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for
  transport/worker retries. A new manual print creates a new operation and therefore a new key.
  Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh
  `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with
  `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime
  availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within
  each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are
  skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must
  carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and
  existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch
  ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration
  tests are separate commands.

## License

MIT — see [LICENSE](LICENSE).
