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

Current results: **134 gateway tests without a database** (56 skipped pending PostgreSQL).
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

**PRODUCTION READY WITH WARNINGS.** All software paths above are verified by automated tests
(including against a real PostgreSQL and a real WebSocket client), and the Windows agent
cross-compiles and vets cleanly. **Physical printing is `NOT VERIFIED — physical printer test
unavailable`**, the Windows PDF submission call is **COMPILE VERIFIED** only, and the Odoo
end-to-end flow **REQUIRES LIVE ODOO**. Close those gaps with
[WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md) before calling a deployment verified;
details in [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).

## License

MIT — see [LICENSE](LICENSE).
