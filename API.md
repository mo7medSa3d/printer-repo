# Gateway API reference

Every endpoint below exists in `src/app/api/**/route.ts` and was checked against its
implementation. The gateway runs behind a custom server (`server.ts`) so the WebSocket
endpoint shares the HTTP port (default `3000`).

## Authentication domains

| Domain | Credential | Used by | Implementation |
|---|---|---|---|
| **Agent** | `Authorization: Bearer <agentId>:<secret>` (secret stored as SHA-256, compared timing-safely) | Go agent | `src/lib/agent-auth.ts` |
| **Manager** | `Cookie: mgr_session=<JWT>` (httpOnly, 8 h) or `Authorization: Bearer <jwt>`; the `jti` must exist unrevoked in `manager_sessions` | Dashboard, desktop app | `src/lib/manager-auth.ts` |
| **Odoo** | `Authorization: Bearer odoo_<key>` or `X-Api-Key: odoo_<key>` (SHA-256 in `api_keys.hashed_key`, optionally branch-scoped, optional `allowedDocumentTypes`) | Odoo addon | `src/lib/odoo-auth.ts` |

Manager sessions are global (not branch-scoped). Odoo keys are usually branch-scoped.
Agents are scoped to their own id and, when set, their branch.

---

## 1. Odoo → Gateway

### `POST /api/print/jobs` — create a print job

Auth: Odoo key. Two request shapes are accepted.

**Branch-routed body (preferred, no printer id):**

```json
{
  "branchId": "branch_cairo",
  "destinationId": "dest_pos_1",
  "documentType": "receipt",
  "payload": { "type": "pdf", "encoding": "base64", "data": "JVBERi0xLjQK…" },
  "expiresAt": "2026-09-01T12:00:00Z",
  "idempotencyKey": "sale.order-42"
}
```

`expiresAt` and `idempotencyKey` are optional. `documentType` is matched
case-insensitively against bindings **and** against the key's `allowedDocumentTypes`.

**Legacy body (explicit printer, kept for migration):**

```json
{ "printerId": "printer_net_ab12", "payload": { … }, "expiresAt": "…", "idempotencyKey": "…" }
```

Processing: key validation → document-type authorization → payload validation
(`raw|escpos|pdf`, base64, 1 B … 5 MiB, canonical encoding) → `expiresAt` parsing →
idempotency lookup → routing → insert `queued` → claim-and-deliver.

**201 Created**

```json
{
  "jobId": "job_V1StGXR8Z5jd",
  "status": "claimed",
  "printerId": "printer_spooler_9ab1",
  "agentId": "agt_7f3c",
  "branchId": "branch_cairo",
  "destinationId": "dest_pos_1",
  "documentType": "receipt",
  "fallbackUsed": true,
  "fallbackChain": ["printer_a", "printer_spooler_9ab1"]
}
```

`status` is the real row status: `claimed` when the job was delivered to a connected agent,
`queued` when it is waiting for the poll path. `fallbackUsed`/`fallbackChain` appear only
when a fallback binding was used. The legacy body returns
`{jobId, status, printerId, agentId}`.

**200 OK** — idempotency hit: the existing job is returned unchanged (same `jobId`).

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error":"…"}` | invalid JSON/body, invalid payload, `expiresAt` not ISO-8601 or not in the future, `INVALID_BRANCH`, `INVALID_DESTINATION` |
| 401 | `{"error":"Unauthorized (invalid branch-scoped Odoo API key)"}` | unknown/revoked key or wrong branch |
| 403 | `{"error":"API key is not allowed to create this document type"}` | `allowedDocumentTypes` / `read_only` scope; legacy path also 403 on cross-branch printer |
| 404 | `{"error":"NO_ROUTE: …"}` / `NO_PRINTER_FOUND` | no matching binding / no printer row |
| 409 | `{"error":"PRINTER_DISABLED: …","code":"PRINTER_DISABLED"}` | every candidate printer is administratively disabled |
| 400 | `{"error":"…payload declares type \"raw\" but the data is a PDF document…"}` | the declared payload type does not match the actual bytes (PDF masquerading as raw/escpos, or vice versa) |
| 409 | `{"error":"CROSS_BRANCH_BINDING: …","code":"CROSS_BRANCH_BINDING"}` | a binding in this branch points at a printer whose derived branch (printer → agent → branch) is different or unresolvable. Reported distinctly rather than as 404, so a misconfiguration is not mistaken for a missing route |
| 422 | `{"error":"CAPABILITY_MISMATCH: …","code":"CAPABILITY_MISMATCH"}` | payload type cannot be rendered by the routed printer |
| 503 | `{"error":"PRINTER_OFFLINE: …","code":"PRINTER_OFFLINE"}` | candidates are offline/error |
| 500 | `{"error":"INTERNAL_ERROR: …"}` | routing/database failure (never disguised as 404) |

**Input limits.** `branchId`, `destinationId` and `printerId` are capped at 128 chars,
`documentType` at 64, `idempotencyKey` at 200, names at 200 and agent `metadata` at 8 KiB
serialized. The payload cap is unchanged at 5 MiB decoded. Oversized input is rejected with
400 before it reaches the database.

**Delivery guarantee.** Job creation is exactly-once per idempotency key; physical printing
is **at-least-once** (see ARCHITECTURE.md §8b). Retry an ambiguous failure with the *same*
idempotency key — a new key means a new logical print operation and a second physical page.

Branch-routed errors include a machine-readable `code`; the legacy path returns the code as
part of the `error` string.

### `GET /api/print/jobs?id=job_xxx[&branchId=…]` — job status

Auth: Odoo key (branch-scoped keys must match the job's branch).

```json
{
  "jobId": "job_V1StGXR8Z5jd", "status": "success",
  "printerId": "printer_spooler_9ab1", "agentId": "agt_7f3c",
  "branchId": "branch_cairo", "destinationId": "dest_pos_1",
  "documentType": "receipt", "error": null, "retries": 0,
  "expiresAt": "2026-09-01T12:00:00.000Z", "updatedAt": "2026-09-01T11:02:13.442Z"
}
```

400 without `id`, 401 unauthenticated, 403 cross-branch, 404 unknown id.

### `POST /api/odoo/sync` — push business configuration

Auth: Odoo key, branch-scoped. Body (all arrays optional; `document_types`/`documentTypes`
both accepted, ids may be integers or strings):

```json
{
  "branches":     [{"id":"branch_cairo","name":"Cairo","description":null,"location":"Cairo","enabled":true}],
  "destinations": [{"id":"dest_pos_1","branchId":"branch_cairo","name":"POS","type":"pos","zone":null,"enabled":true}],
  "documentTypes":[{"id":"dt_receipt","branchId":"branch_cairo","name":"receipt","payloadHint":"pdf","enabled":true}],
  "bindings":     [{"id":"bind_1","branchId":"branch_cairo","destinationId":"dest_pos_1",
                    "documentType":"receipt","printerId":"printer_spooler_9ab1","priority":1,"enabled":true}]
}
```

Behaviour (`src/app/api/odoo/sync/route.ts`):

1. authenticate; resolve **exactly one** branch for the whole payload (a payload mixing
   branches is rejected as a whole);
2. validate the shape and branch ownership of every object — all ids normalised to trimmed
   strings first, so Odoo integer ids and gateway text ids compare correctly;
3. every binding must reference a destination that is in the same payload or already in the
   gateway **and in the branch**, and a printer that already exists **in the branch**;
4. only then upsert `branches → destinations → document types → bindings` inside a single
   transaction. Any failure rolls the whole sync back.

Printers are owned by the gateway (agent registration/discovery) and are **never created**
by this endpoint.

**200 OK**

```json
{ "success": true, "branchId": "branch_cairo",
  "synced": {"branches":1,"destinations":1,"documentTypes":1,"bindings":1},
  "branches":[{"id":"branch_cairo","action":"upserted"}], "destinations":[…],
  "documentTypes":[…], "bindings":[…] }
```

**400** — validation or dependency failure, nothing written:

```json
{ "success": false, "error": "SYNC_VALIDATION_FAILED", "branchId": "branch_cairo",
  "details": [{"entity":"binding","id":"bind_1","bindingId":"bind_1",
               "printerId":"printer_x","reason":"printer belongs to branch other, not to the synchronized branch branch_cairo"}] }
```

```json
{ "success": false, "error": "SYNC_DEPENDENCY_MISSING", "branchId": "branch_cairo",
  "details": [{"entity":"binding","bindingId":"bind_1","printerId":"printer_x",
               "reason":"printer does not exist in the gateway yet — printers are registered by agents, retry the sync after the agent reports it"}] }
```

Other statuses: 400 `INVALID_JSON`, 401 `UNAUTHORIZED`, 403 `SYNC_VALIDATION_FAILED`
(branch-scoped key used for another branch), 500 `SYNC_INTERNAL_ERROR` after a rollback.
`{"success": true}` is never returned when part of the payload failed.

### `GET /api/odoo/sync?branchId=…` — runtime status for Odoo

Auth: Odoo key. Returns `{branchId, agents[≤50], printers[≤100], jobs[≤50]}` for the branch
(20/20/20 when no branch filter). Agent secrets and pairing codes are stripped.
500 on a database error (never an empty-but-successful payload).

### `GET /api/odoo/agents?branchId=…` and `GET /api/odoo/printers?branchId=…`

Auth: Odoo key. Branch-filtered lists used by the addon's "Sync from Gateway" action.
Secrets are stripped; 500 on a database error.

---

## 2. Agent → Gateway

### `POST /api/agent/register` — pairing

No auth (the pairing code is the credential).

```json
{ "pairingCode": "AB12CD",
  "metadata": {"hostname":"pos-pc-1","os":"windows","version":"1.0.0"} }
```

> **`branchId` is not part of this contract and is actively rejected.** The
> schema is strict: sending `branchId` returns **400**, naming the field. A
> device must not be able to choose which branch it joins — the branch is a
> property of the Agent record that a manager created deliberately, and every
> printer the agent reports derives its branch from it. Clients that previously
> sent the field must simply stop sending it; the value was already ignored in
> favour of the persisted agent branch.

The code is uppercased/trimmed, must be unexpired, and is consumed atomically (a racing
second registration gets 409). The agent keeps the branch it was created with; pairing
never moves an agent between branches. `metadata` is capped at 8 KiB.

**200** `{"agentId":"agt_7f3c","secret":"<shown once>"}` — only the SHA-256 hash is stored.
400 invalid/expired code **or a rejected `branchId`/unknown field**, 409 code already used,
500 internal error.

### `POST /api/agent/heartbeat`

Auth: agent. Sent every 30 s.

```json
{ "status": "online",
  "printers": [
    { "id":"printer_spooler_9ab1", "name":"HP LaserJet", "type":"spooler",
      "printerType":"laser", "connectionType":"spooler", "protocol":"spooler",
      "status":"online", "enabled":true,
      "config":{"spooler_name":"HP LaserJet","port_name":"USB001","driver_name":"HP LaserJet"},
      "capabilities":{"supported_protocols":["raw","escpos","pdf"]} } ] }
```

Updates `agents.status`/`lastSeenAt` and upserts each printer **scoped to the calling
agent** — a printer row owned by another agent is skipped, never overwritten (so an agent
cannot pull another branch's printer into its own branch). The heartbeat **never writes a
branch onto a printer**: the printer's branch is whatever its owning agent's branch is at
read time. An existing
printer's `enabled` flag is operator-controlled and is **not** overwritten by a heartbeat
(a disabled printer stays disabled). Values are
normalised/whitelisted: `type` ∈ `network|usb|spooler|tcp|ipp|ipps`, `connectionType` ∈
`tcp|network|usb|spooler|ipp|ipps`, `protocol` ∈ `raw|escpos|ipp|ipps|spooler|windows_spooler`,
`status` ∈ `online|offline|busy|error|unknown`. `capabilities.supported_protocols` is what
routing uses for the capability check.

**200** `{"success":true,"skippedPrinters":["printer_x"]}`. 401 unauthenticated, 500 internal.

### `GET /api/agent/jobs` — claim work (poll path)

Auth: agent. In one request the gateway:

1. expires this agent's non-terminal jobs whose `expires_at` has passed;
2. fails stale `claimed`/`printing` jobs with `retries >= 5`;
3. claims, with `FOR UPDATE SKIP LOCKED` + `UPDATE … RETURNING`, up to 20 jobs that are
   `queued` **or** stale `claimed`/`printing` (silent > 90 s, `retries < 5`, `retries + 1`),
   stamping `claimed_at`, `delivered_at` and `delivery_attempts + 1`.

All steps are scoped to the agent (and its branch when set). Two concurrent pollers can
never receive the same job.

**200** — array of already-claimed jobs:

```json
[{ "id":"job_V1StGXR8Z5jd", "branchId":"branch_cairo", "agentId":"agt_7f3c",
   "printerId":"printer_spooler_9ab1", "destinationId":"dest_pos_1",
   "documentType":"receipt", "status":"claimed",
   "payload":{"type":"pdf","encoding":"base64","data":"…"},
   "expiresAt":"2026-09-01T12:00:00.000Z", "retries":0 }]
```

### `PATCH /api/agent/jobs` — report progress

Auth: agent. Body `{"jobId":"job_…","status":"printing|success|failed|expired","error":"…"}`
(`error` optional, truncated to 2000 chars).

Rules: the job must belong to this agent (and branch) → otherwise **404 "Job not found"**
(identical for "unknown id" and "someone else's job", so ids cannot be probed); TTL wins
(expired ⇒ the row is set to `expired`, response 409); the transition must be allowed
(`claimed → printing|failed|expired`, `printing → success|failed|expired`) → otherwise 409.

**200** `{"success":true,"status":"printing"}`.

### `GET /api/agent/ws` / WebSocket upgrade

`GET` over plain HTTP returns **426 Upgrade Required**. The real endpoint is the WebSocket
upgrade handled in `server.ts`; see [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md).

---

## 3. Manager (dashboard + desktop app)

All require a manager session unless stated otherwise.

| Endpoint | Notes |
|---|---|
| `POST /api/auth/manager/login` | `{username,password}` → `{ok:true,expiresAt}` + `Set-Cookie: mgr_session` (httpOnly, 8 h). 400 missing fields, 401 bad credentials, 429 too many attempts (`Retry-After`), 503 limiter store unavailable, 500 when manager auth is not configured |
| `POST /api/auth/manager/logout` | Revokes the session row, clears the cookie |
| `GET /api/auth/manager/me` | `{authenticated:true,jti,exp}` or 401 |
| `GET /api/health` | **No auth.** Liveness only: `{ok:true}` when PostgreSQL answers `select 1`; `{ok:false}` + 500 when the database is unreachable. Inventory/job counts are **not** returned. |
| `GET /api/agents` | List agents (secrets stripped) |
| `GET /api/agents/:id` | `{agent, printers, jobCount}` (secret stripped), 404 unknown |
| `GET /api/branches` · `POST /api/branches` | List / create a branch (`{name,description,location,timezone,enabled}` → 201 `{id,name}`) |
| `GET/POST /api/branches/:id/destinations` | List / create destinations for the branch |
| `GET/POST /api/branches/:id/printer-bindings` | List / create bindings. POST validates that the destination belongs to the branch and that the printer's **derived** branch (printer → agent → branch) matches it (400/404 otherwise) |
| `GET /api/printers` · `POST /api/printers` | List / manually create a printer. **A printer is created against an agent only** — `agentId` is required and the branch is derived from it (`printer → agent → branch`); the response echoes the derived `branchId`, which is not stored on the printer row. A `branchId` in the body is accepted purely as an optional *assertion*: if it disagrees with the agent's branch the request is rejected 400, and it is never persisted. Also validates ids, `type`, `connectionType`, `printerType`, `protocol`, `config` (network needs `ip`+`port`, spooler needs `spooler_name`/`address`). 404 unknown agent, 400 agent without a branch, 409 duplicate id |
| `GET/PATCH/DELETE /api/printers/:id` | Read / update / delete a printer. `branchId` is **read-only/derived** and is returned but not settable: PATCHing it returns 400. To move a printer between branches, move its agent or set `agentId` to an agent in the target branch |
| `POST /api/printers/:id/test-connection` | **Diagnostic RPC, creates no job.** Returns `{reachable, latencyMs, agentOnline, error}`. `latencyMs` is always `null`: the value comes from the last heartbeat, the gateway cannot dial the LAN. A live agent probe is not implemented |
| `POST /api/printers/:id/test-print` | **Real job.** Accepts a manager session *or* a branch-scoped Odoo key (used by the addon's Test Print button). Builds an ESC/POS test payload and runs the normal pipeline → 201 `{ok:true,jobId,printerId}`. 404 unknown printer, 409 disabled printer |
| `GET /api/jobs?status=&printerId=&agentId=&limit=` | Job list for the manager UI; filters are applied in SQL before `LIMIT` (max 200). 400 on an unknown status |
| `GET /api/jobs/:id` | Single job row, 404 unknown |
| `GET /api/odoo/keys` · `POST /api/odoo/keys` | List key metadata / create a key (`{name,branchId,scope,allowedDocumentTypes,description}`). 201 returns the plaintext `apiKey` **once** |

---

## 4. Shared payload contract

```json
{ "type": "raw" | "escpos" | "pdf", "encoding": "base64", "data": "<base64 1 B … 5 MiB>" }
```

Enforced identically by `src/lib/payload.ts` (Zod + canonical base64 round-trip) and
`agent/internal/payload/payload.go` (strict `base64.StdEncoding`). The three types are not
interchangeable:

| type | meaning | printers that accept it |
|---|---|---|
| `raw` | opaque printer-native byte stream | RAW TCP 9100, Windows spooler (RAW datatype), raw USB, IPP (`application/octet-stream`) |
| `escpos` | ESC/POS command stream (`ESC @` … `GS V`) | same as `raw` — ESC/POS is a payload dialect, not a transport |
| `pdf` | a real PDF document, validated (`%PDF-` … `%%EOF`) | Windows spooler through the PDF pipeline, IPP (`application/pdf`) |

A `pdf` payload is never relabelled as `raw`. An incompatible combination fails with
`CAPABILITY_MISMATCH` — HTTP 422 at creation time, or `job.status=failed` with
`job.error` starting `CAPABILITY_MISMATCH:` when the agent detects it. Details and the
per-backend matrix: [PRINTERS.md](PRINTERS.md).

## 5. Job status vocabulary

`queued → claimed → printing → success | failed`, plus `expired` for any non-terminal job
past its TTL. The full state machine, the claim/delivery fields and the recovery rules are
documented in [docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md).
