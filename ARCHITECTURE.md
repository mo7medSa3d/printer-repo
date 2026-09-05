# Architecture

> Source of truth: the code in this repository. Every statement below was checked against
the implementation at the commit that introduced this document. Paths are given so any
claim can be re-verified.

## 1. System overview

```
Odoo (ERP / POS)
   │  user presses Print on a QWeb report
   ▼
print_gateway addon                      odoo_addons/print_gateway
   │  report mapping → branch / destination / document type → PDF payload
   │  HTTPS  POST /api/print/jobs        Authorization: Bearer odoo_<key>
   ▼
Cloud Gateway (Next.js 16 + custom HTTP/WS server)      server.ts, src/
   │  authenticate → validate payload → resolve route → INSERT print_jobs (queued)
   ▼
PostgreSQL                                src/db/schema.ts, drizzle/*.sql
   │  durable job queue + configuration + runtime state
   ▼
Routing                                   src/lib/routing.ts
   │  branch + destination + documentType + payload type → printer + agent
   ▼
Claim (single transaction)                src/lib/job-delivery.ts
   │  SELECT … FOR UPDATE SKIP LOCKED + UPDATE status='claimed'
   ▼
Delivery                                  src/server/ws.ts  |  src/app/api/agent/jobs/route.ts
   │  WebSocket push {"type":"print_job"}  ─or─  poll response (HTTP GET)
   ▼
Agent (Go, Windows service)               agent/
   │  job_ack → local SQLite queue → per-printer lock
   ▼
Printer backend                           agent/internal/printer/
   │  RAW TCP · Windows spooler · PDF pipeline · IPP · USB
   ▼
Physical printer                          (hardware — NOT verified in CI)
   │
   ▼
Job status                                PATCH /api/agent/jobs (printing → success/failed)
   ▼
Gateway (PostgreSQL print_jobs)
   ├──► Odoo        GET /api/print/jobs?id=…      (cron every 2 min)
   └──► Desktop Manager  GET /api/health, GET /api/jobs   (polling, no WebSocket)
```

## 2. Components and responsibilities

| Component | Location | Responsibility |
|---|---|---|
| **Gateway** | `server.ts`, `src/app/api/**`, `src/lib/**`, `src/server/ws.ts` | Authentication, payload validation, routing, durable job queue, claim/delivery protocol, status machine, manager dashboard |
| **PostgreSQL** | `src/db/schema.ts`, `drizzle/*.sql` | The only durable store for configuration, agents, printers and jobs |
| **Agent** | `agent/` (Go 1.21, built with the toolchain in CI) | Runs on the Windows PC next to the printers: registration, heartbeat, discovery, WebSocket + poll delivery, local SQLite queue, physical printing |
| **Desktop Manager** | `src-tauri/` (Rust/Tauri 2) + `src/desktop/` (React) | Windows tray app that installs/controls the agent service, pairs it with the gateway, lists/tests printers, shows gateway health. Never prints directly |
| **Odoo addon** | `odoo_addons/print_gateway/` | Business configuration (branches, destinations, document types, bindings, report mappings), report interception, job creation and status tracking |
| **Gateway manager console** | `src/app/dashboard` | Browser UI for managers: agents, printers, discovery and recent jobs. Production surface; no browser agent simulator is shipped. |

The gateway is the only component that talks to PostgreSQL. The agent never reaches the
database, and the desktop app never talks to a printer directly — it always goes
Desktop → Gateway → Agent → printer, or Desktop → local agent CLI over Tauri IPC for
local discovery/registration.

## 3. Source of truth per entity

| Entity | Owner | Created by | Notes |
|---|---|---|---|
| Branch | **Odoo** | `POST /api/odoo/sync` (upsert) or manager `POST /api/branches` | Odoo is authoritative for business config |
| Destination (POS, kitchen, warehouse…) | **Odoo** | `POST /api/odoo/sync`, manager `POST /api/branches/:id/destinations` | Must belong to exactly one branch |
| Document type (receipt, invoice…) | **Odoo** | `POST /api/odoo/sync` | Matched case-insensitively during routing |
| Printer binding (destination + document type → printer) | **Odoo** | `POST /api/odoo/sync`, manager `POST /api/branches/:id/printer-bindings` | Carries `priority` for fallback |
| Agent | **Gateway** | Manager creates a pairing code → `POST /api/agent/register` | Odoo can only read agents |
| Printer (runtime registration + status) | **Gateway/Agent** | `POST /api/agent/heartbeat` (discovery), manager `POST /api/printers` | **Never created by the Odoo sync** (`src/app/api/odoo/sync/route.ts`) |
| Print job | **Gateway** | `POST /api/print/jobs`, manager test print | Odoo keeps a mirror record `print_gateway.print_job` |

The sync endpoint enforces this split: it upserts branches/destinations/document
types/bindings and *validates* that referenced printers already exist, returning
`SYNC_DEPENDENCY_MISSING` instead of inventing printer rows.

## 4. Data model and relationships

Ten tables (`src/db/schema.ts`):

```
branches ─┬─< destinations ─┐
          ├─< document_types │
          ├─< local_networks │
          ├─< agents ─< printers ──┐
          ├─< api_keys             │
          └─< printer_bindings >───┘   (branch, destination, documentType) → printer
                 │
                 └─ used by routing to pick the printer for a job

print_jobs → branch, destination, agent, printer      (jobs are always branch-scoped)
manager_sessions                                       (dashboard/JWT session rows)
```

Routing walks the chain `branch → destination (+ document type) → printer_bindings
ordered by priority → printer → agent`, skipping candidates that are missing,
cross-branch, disabled, offline or capability-incompatible
(`resolvePrinterForJob` in `src/lib/routing.ts`).

See [docs/DATABASE.md](docs/DATABASE.md) for the full column-level reference.

## 5. Branch isolation

Branch scoping is enforced at every layer, not just in the UI:

* **Odoo API keys** may be branch-scoped (`api_keys.branch_id`). `validateOdooKey(req, branchId)`
  rejects a key used for another branch (`src/lib/odoo-auth.ts`).
* **Job creation** resolves the printer only inside the requested branch and refuses a
  binding whose printer, or whose printer's agent, belongs to a different branch
  (`src/lib/routing.ts`).
* **Agent endpoints** filter by `agent.branchId` when the agent is scoped (`branchFilter` in
  `src/app/api/agent/jobs/route.ts`); an agent cannot claim, read or update another branch's or
  another agent's jobs (identical 404 for both cases).
* **Odoo sync** accepts exactly one branch per payload and rejects cross-branch
  destinations/printers (`src/app/api/odoo/sync/route.ts`).
* **Manager bindings API** validates destination, printer and the printer's agent all
  share the branch (`src/app/api/branches/[id]/printer-bindings/route.ts`).

Manager sessions are **global**, not per-branch: a signed-in manager sees every branch.

## 6. Two queue layers

| Layer | Store | States | Purpose |
|---|---|---|---|
| Gateway | PostgreSQL `print_jobs` | `queued → claimed → printing → success \| failed \| expired` | Ownership, delivery bookkeeping, retries, TTL |
| Agent | SQLite WAL (`agent/internal/queue/queue.go`) | `queued → printing → success \| failed` | Crash-safe local record, duplicate suppression, terminal-result replay |

The local record id equals the gateway job id, which is what makes duplicate delivery
detection and terminal-result replay possible. Details in
[docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md).

## 7. Delivery paths

* **WebSocket** (`/api/agent/ws`, attached in `server.ts` via `attachAgentWSS`): the gateway
  claims the job in a transaction and only then writes the `print_job` envelope to a single
  open socket; the agent answers `job_ack`. See [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md).
* **Polling** (`GET /api/agent/jobs`): the same claim happens inside the SQL statement that
  returns the rows; the HTTP response *is* the delivery. The agent polls every 10 s when the
  socket is down and every ~30 s as a safety net while it is up, which is what recovers a
  claim whose WebSocket delivery was lost.
* The desktop manager has **no** WebSocket; it polls `/api/health` and `/api/jobs`.

## 8. Payload semantics

`raw`, `escpos` and `pdf` are three distinct, non-interchangeable payload types shared by
`src/lib/payload.ts` and `agent/internal/payload/payload.go` (both cap the decoded body at
5 MiB). A PDF is never relabelled as raw bytes; a printer that cannot render a type causes
`CAPABILITY_MISMATCH`. The full matrix is in [PRINTERS.md](PRINTERS.md).

## 9. Technology stack

* Next.js 16 (App Router) on Node ≥ 22, started through a custom `server.ts` so the
  WebSocket server shares the HTTP port (default 3000).
* PostgreSQL with Drizzle ORM; migrations are plain SQL files in `drizzle/`.
* Go 1.21 agent (`kardianos/service`, `gorilla/websocket`, `mattn/go-sqlite3`,
  `golang.org/x/sys`).
* Tauri 2 desktop shell (Rust) bundling the agent executables as resources.
* Odoo 16/17/18-compatible Python addon.
* Vitest for gateway tests, `go test` for the agent, GitHub Actions
  (`.github/workflows/build-windows.yml`) for the Windows build and installer.

## Production Engineering Semantics

- **Odoo print outbox:** report actions persist the logical operation and idempotency key inside the Odoo transaction. Gateway submission is registered as a post-commit job; a process crash before submission leaves the durable queued operation for the retry cron.
- **Metrics:** manager-authenticated `GET /api/metrics` exposes process-local Prometheus counters; logs remain the authoritative event stream and never contain payload bytes or credentials.
- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal. A guarded manager-only hard delete is allowed only for an offline, unused Agent with no printers, jobs, or discovery records.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.
