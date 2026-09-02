# Architecture

> Source of truth: the code in this repository. Every statement below was checked against
> the implementation at the commit that introduced this document. Paths are given so any
> claim can be re-verified.

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
| **Dashboard / Simulator** | `src/app/dashboard`, `src/app/simulator` | Browser UI for managers; the simulator page exercises an agent-like flow against the gateway |

The gateway is the only component that talks to PostgreSQL. The agent never reaches the
database, and the desktop app never talks to a printer directly — it always goes
Desktop → Gateway → Agent → printer, or Desktop → local agent CLI over Tauri IPC for
local discovery/registration.

## 2b. Branch authority: who owns business configuration

**Odoo is the source of truth for business configuration. The Gateway is the
runtime control plane.** This is the rule the rest of the system is built on,
and it is now stated once, here, rather than implied in three places.

| Concern | Authority | Why |
|---|---|---|
| Branches, destinations, document types, printer bindings | **Odoo** | They are business decisions (which shop, which counter, which document goes where) |
| Agents, printers, print jobs, delivery state | **Gateway** | They are runtime facts discovered from real machines; Odoo cannot know them |

Configuration flows Odoo → Gateway (`POST /api/odoo/sync`). Runtime state flows
Gateway → Odoo (`GET /api/odoo/agents`, `GET /api/odoo/printers`, job status).
Neither direction ever writes what the other owns: the sync endpoint refuses to
create printers, and Odoo never pushes a printer or a printer's branch.

### The Gateway's branch endpoints are a bootstrap facility

`POST /api/branches` exists so an operator can stand up a gateway *before* Odoo
is connected (and so the test suite can build fixtures). It is a **controlled
bootstrap operation, not a second source of truth**:

* A branch created here has no `gateway_branch_id` linkage until Odoo syncs.
* Once Odoo syncs a branch with the same id, Odoo's values win — the sync is an
  upsert keyed on the branch id.
* Operationally you should create branches in Odoo and let the sync create
  them. Use the gateway endpoint only for bootstrap or recovery.

If both sides create branches independently and routinely, they will drift.
That is a process failure, not something the software can resolve for you —
which is exactly why the authority is written down.

## 3. Source of truth per entity

| Entity | Owner | Created by | Notes |
|---|---|---|---|
| Branch | **Odoo** | `POST /api/odoo/sync` (upsert) or manager `POST /api/branches` | Odoo is authoritative for business config |
| Destination (POS, kitchen, warehouse…) | **Odoo** | `POST /api/odoo/sync`, manager `POST /api/branches/:id/destinations` | Must belong to exactly one branch |
| Document type (receipt, invoice…) | **Odoo** | `POST /api/odoo/sync` | Matched case-insensitively during routing |
| Printer binding (destination + document type → printer) | **Odoo** | `POST /api/odoo/sync`, manager `POST /api/branches/:id/printer-bindings` | Carries `priority` for fallback |
| Agent | **Gateway** | Manager creates the agent **in an explicit branch**, then the device pairs via `POST /api/agent/register` | Odoo can only read agents. The device cannot choose its branch: `branchId` is not part of the registration contract |
| Printer (runtime registration + status) | **Gateway/Agent** | `POST /api/agent/heartbeat` (discovery), manager `POST /api/printers` | **Never created by the Odoo sync** (`src/app/api/odoo/sync/route.ts`). Always belongs to an agent; its branch is derived, never stored |
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

### Branch → Agent → Printer is the only ownership chain

`printers` has **no `branch_id` column**. A printer belongs to an agent
(`printers.agent_id`, `NOT NULL`), and the agent belongs to a branch
(`agents.branch_id`). The printer's branch is therefore always computed:

```
printerBranch = printer.agent.branch_id
```

Why there is no printer-level branch:

* **One writer.** With two columns, `printers.branch_id` and `agents.branch_id`
  could disagree, and every consumer had to pick a winner. Deriving removes the
  possibility of disagreement instead of adding a check for it.
* **Moves are atomic.** Re-homing an agent moves all of its printers in one
  write. There is no second update that can fail halfway.
* **No fallbacks.** Because `agent_id` is `NOT NULL` and FK-constrained, the
  derivation always succeeds for a valid row. Code never writes
  `printer.branch_id ?? "default"`; an unresolvable branch is a loud error.

Helpers: `src/lib/printer-branch.ts`. Queries join `printers → agents` rather
than reading a denormalised column.

Two branch columns are deliberately **kept**, and neither is a second source of
truth for printer ownership:

* `printer_bindings.branch_id` — routing scope (a binding is looked up by
  branch + destination + document type). Validated against the derived printer
  branch on write and during Odoo sync; a mismatch is refused with
  `CROSS_BRANCH_BINDING` (HTTP 409).
* `print_jobs.branch_id` — historical/routing context and the scope of the
  idempotency key. A job records the branch it was printed for and keeps it even
  if the printer's agent is later moved.

Routing walks the chain `branch → destination (+ document type) → printer_bindings
ordered by priority → printer → agent`, skipping candidates that are missing,
cross-branch, disabled, offline or capability-incompatible
(`resolvePrinterForJob` in `src/lib/routing.ts`).

See [docs/DATABASE.md](docs/DATABASE.md) for the full column-level reference.

## 4b. Runtime lifecycle

Agents and printers are runtime entities that print jobs point at with NOT NULL
foreign keys, so they are **retired, never deleted**:

| State | Agent | Printer |
|---|---|---|
| `active` | polls, heartbeats, receives jobs | eligible for routing |
| `disabled` | credentials still valid, but authentication is refused and no work is routed | not selected for new jobs |
| `retired` | credentials **revoked** (`secret` set to NULL); its printers are disabled too | not selected; kept for history |

Both states preserve every job, binding and relationship, so history stays
queryable. Retiring an agent cascades to its printers in one transaction,
because a printer is only reachable through its agent.

Hard deletion still exists for genuinely unused entities but is not the normal
workflow: `deleteAgent` refuses when the agent has any print history or still
owns printers, and names the blocking dependency instead of surfacing a foreign
key error.

## 5. Branch isolation

Branch scoping is enforced at every layer, not just in the UI:

* **Odoo API keys** may be branch-scoped (`api_keys.branch_id`). `validateOdooKey(req, branchId)`
  rejects a key used for another branch (`src/lib/odoo-auth.ts`).
* **Job creation** resolves the printer only inside the requested branch. A binding
  whose printer resolves (via its agent) to a different branch is refused with
  `CROSS_BRANCH_BINDING` → 409 rather than being reported as "no printer found",
  so a misconfiguration is never mistaken for a missing route (`src/lib/routing.ts`).
* **Agent endpoints** filter by `agent.branchId` when the agent is scoped
  (`branchFilter` in `src/app/api/agent/jobs/route.ts`); an agent cannot claim, read or
  update another branch's or another agent's jobs (identical 404 for both cases).
* **Odoo sync** accepts exactly one branch per payload and rejects cross-branch
  destinations, and bindings whose printer derives to another branch
  (`src/app/api/odoo/sync/route.ts`).
* **Manager bindings API** validates that the destination and the printer's derived
  branch (printer → agent → branch) both match the branch in the URL (`src/app/api/branches/[id]/printer-bindings/route.ts`).

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

The declared type must match the actual bytes, and this is **enforced by content
inspection**, not taken on trust:

| Declared | Content | Result |
|---|---|---|
| `pdf` | starts with `%PDF-` | accepted; must route to a printer declaring PDF support |
| `raw` / `escpos` | not a PDF | accepted |
| `raw` / `escpos` | starts with `%PDF-` | **rejected (400)** |
| `pdf` | not a PDF | **rejected (400)** |

Why the third row matters: RAW means "bytes already in the printer's own command
language". A PDF sent to a RAW or ESC/POS transport is not rendered — the device
prints the PDF *source* as text, wasting an entire roll, and it looks like a
hardware fault rather than a mapping mistake. `looksLikePdf()` in
`src/lib/payload.ts` makes that mislabelling impossible to express.

To print a PDF on a byte-stream printer you must genuinely render it to RAW/ESC-POS
first; the system will not silently reinterpret the bytes for you.

## 8b. Delivery guarantee: at-least-once

Physical printing is **at-least-once, not exactly-once**, and the system does not
claim otherwise.

Job *creation* is exactly-once: an idempotency key is unique per
`(branch_id, idempotency_key)`, and a duplicate request returns the existing job
rather than creating a second one.

Physical *output* cannot be. If the agent sends bytes to the device and then
crashes (or the network drops) before it records the acknowledgement, the
gateway cannot distinguish "printed but unacknowledged" from "never printed".
It re-delivers, because losing a customer's receipt is worse than printing it
twice. A duplicate physical page is therefore possible and expected in that
window.

Mitigations that ARE in place: the job is claimed in a transaction before
delivery, a 90-second lease reclaims stale claims, duplicate deliveries of an
already-terminal job are acknowledged but not reprinted, and the agent records a
crash marker so `reprint_after_crash` is an explicit policy rather than an
accident.

On an ambiguous failure (timeout, 5xx) a client must **retry with the same
idempotency key**, which returns the original job instead of starting a new
logical print operation. Generating a fresh key on retry converts an ambiguous
single print into two guaranteed prints.

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
