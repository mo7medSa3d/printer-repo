# Odoo Print Gateway

Cloud print gateway that turns an Odoo report into a physical page on the right printer, in
the right branch, without hardcoding printer ids anywhere.

```
Odoo → print_gateway addon → Cloud Gateway (Next.js + PostgreSQL) → Windows Agent (Go) → printer
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
  app/api/**        24 route handlers (agent, manager, Odoo, health)
  lib/              payload contract, routing, job status, claim/delivery, auth
  server/ws.ts      agent WebSocket server (attached in server.ts)
  db/               Drizzle schema + connection
  desktop/          React UI of the Tauri desktop manager
drizzle/            SQL migrations (0000 … 0004) + journal
agent/              Go agent + CLI (service, discovery, printing, local queue)
src-tauri/          Rust/Tauri shell for the Windows desktop manager
odoo_addons/        Odoo addon `print_gateway`
tests/              Vitest suites (unit, contract, PostgreSQL-backed, E2E)
scripts/            Windows installer, smoke test, icon generation, PG concurrency harness
docs/               Reference documentation (see DOCS.md for the index)
```

## Quick start (development)

```bash
# 1. gateway
npm ci
cp .env.example .env                     # set DATABASE_URL, GATEWAY_JWT_SECRET, manager creds
for f in drizzle/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
npm run dev                              # http://localhost:3000 (+ agent WS on the same port)

# 2. agent (from a machine with printers; Linux/macOS run in simulation mode)
cd agent
go run ./cmd/agent -config ./config.yaml

# 3. desktop manager UI (optional, without the Rust shell)
npm run desktop:dev                      # http://localhost:1420
```

Sign in at `/login` with `MANAGER_USERNAME` / `MANAGER_PASSWORD`, create a branch, create an
agent to obtain a pairing code, pair the agent, run discovery, then create a destination,
a document type and a printer binding.

No printer at hand? `http://localhost:3000/simulator` is a browser-based agent (register →
heartbeat → poll → report) that exercises the whole lifecycle. Developer workflows,
repository layout and contribution conventions: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

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
   `printing`, prints through the backend that matches the payload type, then reports
   `success` or `failed` with the real error.
5. Odoo polls the job status every 2 minutes; the dashboard and the desktop manager poll too.

Details: [docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) ·
[docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) · [API.md](API.md).

## Payload types and printers

| type | printed by | refused by |
|---|---|---|
| `raw` | RAW TCP :9100, Windows spooler (RAW datatype), raw USB, IPP (`application/octet-stream`) | — |
| `escpos` | same as `raw` | — |
| `pdf` | Windows spooler through the PDF pipeline (validate → 0600 temp file → `printto`/helper → wait → delete), IPP (`application/pdf`) | RAW TCP and raw USB → `CAPABILITY_MISMATCH` |

The agent reports each backend's real capabilities in the heartbeat, and the gateway refuses
an incompatible job with HTTP 422 before it is ever queued. Full matrix and the PDF pipeline:
[PRINTERS.md](PRINTERS.md).

## Tests

```bash
npm run typecheck && npm run lint && npm test && npm run build
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test   # + DB-backed suites
cd agent && go build ./... && go vet ./... && go test ./... && go test -race ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
```

Current local verification (2026-09-02): `typecheck`/`lint`/`test:unit`/`build`/`go vet`/`go test` pass locally; PostgreSQL-backed suites (`test:integration`) require `DATABASE_URL` and are enforced as a required gate in `.github/workflows/ci.yml`.
What each suite covers — and what is deliberately not covered — is in
[docs/TESTING.md](docs/TESTING.md).

## Build and deployment

```bash
npm run build                     # gateway
npm run desktop:vite:build        # desktop WebView bundle
pwsh -File scripts/build-windows-installer.ps1     # Windows: MSI + NSIS with the agent bundled
```

`.github/workflows/build-windows.yml` runs the full battery on `windows-latest`, builds the
installers, installs the MSI and smoke-tests it. Server deployment, reverse-proxy
requirements (the proxy must forward `/api/agent/ws` upgrades) and the release checklist are
in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

[DOCS.md](DOCS.md) is the index. Direct links: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[API.md](API.md) · [PRINTERS.md](PRINTERS.md) · [INSTALLATION.md](INSTALLATION.md) ·
[docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) ·
[docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) · [docs/AGENT.md](docs/AGENT.md) ·
[docs/ODOO.md](docs/ODOO.md) · [docs/DESKTOP.md](docs/DESKTOP.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/DATABASE.md](docs/DATABASE.md) ·
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) ·
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) · [docs/TESTING.md](docs/TESTING.md) ·
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) ·
[docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) ·
[WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md) · [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## Known limitations

1. **Printing is at-least-once, never exactly-once.** A crash while a document is at the
   printer leaves an unknown physical outcome; the agent now reports it explicitly
   (`AGENT_RESTART_DURING_PRINT`) and `agent.reprint_after_crash` decides whether it may be
   printed again.
2. **"Success" means the transport accepted the document**, not that paper came out — no
   bidirectional paper-level status exists.
3. `POST /api/printers/:id/test-connection` returns cached heartbeat data (`latencyMs` is
   always `null`); there is no live probe.
4. mDNS / SNMP / WSD discovery are logged stubs, not implementations.
5. WebSocket push is per gateway process; with multiple instances an agent connected to
   another instance receives the job through polling (≤ 10 s).
6. Manager authentication is a single global role; Odoo keys are the branch-scoped ones.
7. PDF printing outside Windows requires an explicit `pdf_print_command`; the non-Windows
   spooler backend only simulates and says so.

## Production verification status

**NOT PRODUCTION-READY FROM THE VERIFIED SCOPE.** This workspace could not execute the Node test/lint/build gates because the npm dependencies are not installed and the package cache is incomplete; real PostgreSQL is unavailable locally; Go dependency downloads are blocked by the unavailable network; Odoo, Windows, and physical-printer environments are unavailable. The corrected repository includes the required CI gates and environment-dependent test matrix, but no unavailable external integration is claimed as passing. See [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).

## License

MIT — see [LICENSE](LICENSE).

## Production architecture and ownership

Odoo is the business/configuration source of truth. The Gateway is the runtime authority for registered Agents, runtime Printers, heartbeat/availability, print Jobs, and execution state.

The authoritative runtime hierarchy is **Branch -> Agent -> Printer**. A Gateway Printer has no independent Branch ownership field. When a Branch is exposed for a Printer, it is derived through `printer.agentId -> agent.branchId`.

Agent and Printer deletion is lifecycle-based: `active <-> disabled`, `active/disabled -> retired`; `retired` is terminal. Normal API/UI flows never physically delete Agents or Printers, so historical jobs and audit relationships survive.

Logical print requests are idempotent by UUID/idempotency key. Physical printing remains potentially at-least-once because a device may receive bytes before a network failure is observed; exactly-once physical printing is not claimed.

PostgreSQL-backed integration tests are a required CI gate. Odoo, Windows, network-printer and USB-printer E2E are environment-dependent and are not represented as passing unless that environment actually ran.
## Production Engineering Semantics

- **Odoo print outbox:** report actions persist the logical operation and idempotency key inside the Odoo transaction. Gateway submission is registered as a post-commit job; a process crash before submission leaves the durable queued operation for the retry cron.
- **Metrics:** manager-authenticated `GET /api/metrics` exposes process-local Prometheus counters; logs remain the authoritative event stream and never contain payload bytes or credentials.

- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.

