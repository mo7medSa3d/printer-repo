# API — Gateway (Next.js, `server.ts` custom WS)

## Auth Domains (separate)

- **Agent:** `Authorization: Bearer <agentId>:<secret>` (SHA256 hash server-side, timing-safe). Use for `POST /api/agent/*`, `GET/PATCH /api/agent/jobs`, `WS /api/agent/ws`. See `src/lib/agent-auth.ts`.
- **Manager:** `Cookie: mgr_session=<JWT>` (httpOnly, 8h, `jti` server row `manager_sessions`) or `Authorization: Bearer <jwt>`. Use for `GET /api/agents|printers|jobs`, `POST /api/printers/*`, `POST /api/odoo/keys`, `GET /api/branches*`. See `docs/AUTH.md`, `src/lib/manager-auth.ts`.
- **Odoo:** `Authorization: Bearer odoo_xxx` or `X-Api-Key: odoo_xxx` (SHA256 `api_keys.hashedKey`, branch-scoped). Use for `POST /api/print/jobs`, `GET /api/print/jobs?id=`, `GET /api/odoo/*`, `POST /api/odoo/sync`. See `src/lib/odoo-auth.ts`.

## Agent ↔ Gateway

### 1. Register (Pairing)
`POST /api/agent/register` (no auth) `src/app/api/agent/register/route.ts:7`
```json
{ "pairingCode": "AB12CD", "branchId": "branch_cairo", "metadata": {"hostname":"pc-1","os":"windows","version":"1.0.0"} }
```
→ `200 {agentId, secret}` — secret shown once, stored hashed. Code 6 chars, uppercase, 30m, single-use with race check. `branchId` optional but validated if provided (`branch not found` 404, `branch disabled` 409).

### 2. Heartbeat (Agent → Gateway only)
`POST /api/agent/heartbeat` (agent auth) `src/app/api/agent/heartbeat/route.ts:80`
```json
{ "status":"online", "printers":[
  {"id":"printer_spooler_xxx","name":"HP LaserJet","type":"spooler","printerType":"laser","connectionType":"spooler","protocol":"spooler","status":"online","enabled":true,"config":{"spooler_name":"HP LaserJet","port_name":"USB001","driver_name":"HP LaserJet"}},
  {"id":"printer_net_xxx","name":"Kitchen 9100","type":"network","connectionType":"network","protocol":"escpos","status":"online","config":{"ip":"192.168.1.50","port":9100,"protocol":"escpos"}},
  {"id":"printer_usb_xxx","name":"Zebra GK420","type":"usb","connectionType":"usb","protocol":"raw","status":"unknown","config":{"address":"USB\\VID_0A5F&PID_014E\\123","vid":2655,"pid":334,"serial":"123"}},
  {"id":"printer_ipp_xxx","name":"Office IPP","type":"ipp","connectionType":"ipp","protocol":"ipp","status":"online","config":{"ip":"192.168.1.60","port":631,"address":"ipp://192.168.1.60/ipp/print"}}
]}
```
Server upserts `agents.lastSeenAt` and `printers` scoped to `agent.id` (cannot overwrite other agent's printer). Validates `type` `network/usb/spooler/tcp/ipp/ipps`, `connectionType` `tcp/network/usb/spooler/ipp/ipps`, `protocol` `raw/escpos/ipp/ipps/spooler`.

### 3. Poll Jobs (atomic lease)
`GET /api/agent/jobs` (agent auth) — does TTL sweep, fail stale >90s retries>=5, then `WITH claimable ... FOR UPDATE SKIP LOCKED` claims `queued` + reclaimable `claimed/printing` up to 20, `RETURNING id,branchId,agentId,printerId,destinationId,documentType,status,payload,expiresAt,retries`. Every returned row is already `claimed` in the database — the agent never receives a job it does not own. The HTTP response *is* the delivery for this path, so `delivered_at` and `delivery_attempts` are set in the same statement. Two pollers never get the same job. Scoped by `agent.branchId` (`branchFilter`).

While the WebSocket is connected the agent still polls every 3rd tick (~30s) as a safety net, so a claim whose WS delivery was lost is reclaimed after the 90s lease instead of waiting for a disconnect.

### 4. Update Job Status
`PATCH /api/agent/jobs` (agent auth) `{"jobId","status":"printing|success|failed|expired","error?"}`
- TTL wins: if `expiresAt <= now()` and not terminal → 409 `expired`.
- `canTransition` `src/lib/job-status.ts:34`: `claimed→{printing,failed,expired}`, `printing→{success,failed,expired}`, terminal blocks.
- Scoped to `agentId` + `branchId`; 404 if job belongs to other agent.

### 5. WebSocket (Agent only)
`WSS /api/agent/ws` — handled in `server.ts` + `src/server/ws.ts` (Next route returns 426). Upgrade with `Authorization: Bearer agt:secret`. Server validates, then `attachAgentWSS` tracks `Map<agentId,Set<WS>>`, ping/pong 30s, 64 KiB max frame. Desktop **does not** use WS — polls HTTPS.

**Claim-before-delivery (mandatory ordering).** `claimAndPushJobToAgent` (`src/server/ws.ts`) never sends a job the gateway does not already own:

1. no open socket for the agent → return `no_socket`, the row stays `queued` for the poll path;
2. `claimJobForDelivery` (`src/lib/job-delivery.ts`) opens a transaction, runs
   `SELECT ... WHERE id=$1 AND agent_id=$2 AND status='queued' AND expires_at>now() FOR UPDATE SKIP LOCKED`
   and, in the same transaction, `UPDATE ... SET status='claimed', claimed_at=now(), delivery_attempts=delivery_attempts+1`. A concurrent claimer gets nothing (`not_claimable`);
3. only after that transaction commits is the job written to exactly ONE open socket (the newest; sending to every socket of an agent would be a duplicate delivery);
4. on success `delivered_at` is stamped; if the socket write fails the claim is released with `releaseUndeliveredClaim` → the row goes back to `queued` **under the same job id** (`requeued`), or is failed with an explicit error once `MAX_DELIVERY_ATTEMPTS` (5) is exhausted (`failed`).

An agent therefore can never see a `queued` job as executable, and “sent” is never treated as “printed”.

**Delivery envelope (Gateway → Agent):**
```json
{ "type": "print_job",
  "job": { "id": "job_xxx", "branchId": "branch_cairo", "agentId": "agt_xxx",
           "printerId": "printer_xxx", "destinationId": "dest_pos_1",
           "documentType": "receipt", "status": "claimed",
           "payload": {"type":"pdf|raw|escpos","encoding":"base64","data":"..."},
           "expiresAt": "2026-09-01T12:00:00Z", "retries": 0 },
  "id": "job_xxx", "printerId": "printer_xxx", "payload": { }, "expiresAt": "..." }
```
The flat `id`/`printerId`/`payload`/`expiresAt` aliases keep older agent builds working.

**Acknowledgement (Agent → Gateway):**
```json
{ "type": "job_ack", "jobId": "job_xxx" }
```
The agent sends it immediately on receipt — including for a duplicate delivery it will not print. The gateway records `acked_at` (and `delivered_at` if missing) and **does not** change the job status: an ack is receipt, never progress. Unknown message types are ignored.

**Recovery.** A claimed job that is never delivered or never reported on is reclaimed by the poll endpoint after the 90s claim lease (`CLAIM_LEASE_SECONDS` == `STALE_CLAIM_SECONDS`), which increments `retries` and re-delivers **the same job id**; after `retries>=5` it is failed permanently. New job ids are never minted for a redelivery.

## Manager (Desktop + Dashboard)

All require `validateManager` (cookie/JWT 8h).

- `POST /api/auth/manager/login` `{username,password}` → `Set-Cookie: mgr_session` (see `docs/AUTH.md`)
- `POST /api/auth/manager/logout` → revoke `jti`
- `GET /api/auth/manager/me`
- `GET /api/health` (no auth, but counts are best-effort) → `{ok, agents:{total,online}, printers:{total,online}, jobs:{queued,failed}}`
- `GET /api/agents` / `GET /api/agents/:id` (strips `secret`)
- `GET /api/branches` / `POST /api/branches` / `GET /api/branches/[id]/destinations` `POST .../destinations` / `GET/POST /api/branches/[id]/printer-bindings` — all branch-scoped, `POST /printer-bindings` validates `destination.branchId==branchId, printer.branchId==branchId, agent.branchId==branchId` else `400`
- `GET /api/printers` / `POST /api/printers` / `GET/PATCH/DELETE /api/printers/:id` — validates `ip:port`, `type` `network/usb/spooler/tcp/ipp/ipps`, `protocol` `raw/escpos/ipp/ipps/spooler`, `connectionType`, `printerType`, `branch consistency` (printer `branchId` must match `agent.branchId`)
- `POST /api/printers/:id/test-connection` — **RPC, no job row** `src/app/api/printers/[id]/test-connection/route.ts:1` → `{reachable, latencyMs, agentOnline, error}` (cached from heartbeat, `latencyMs:null` until live WS probe)
- `POST /api/printers/:id/test-print` — **real job** `buildTestPrintPayload` → `createPrintJob` → `queued → claimed(lease) → printing → success/failed` + claim-aware WS push
- `GET /api/jobs?status=&printerId=&agentId=&limit=` / `GET /api/jobs/:id` (manager read) — filters applied in SQL `WHERE` before `LIMIT`; unknown `status` → `400`
- `GET /api/odoo/keys` / `POST /api/odoo/keys` (manager) — `POST` creates `odoo_xxx` with `branchId, scope, allowedDocumentTypes`

## Odoo → Gateway

### Primary: Branch-Scoped Routing (preferred, no hardcoded printer ID)
`POST /api/print/jobs` (Odoo key, branch-scoped) `src/app/api/print/jobs/route.ts:20` `branchBodySchema`:
```json
{
  "branchId": "branch_cairo",
  "destinationId": "dest_pos_1",
  "documentType": "order", // or receipt, invoice, delivery, picking, purchase_order, label - matches printerBindings.documentType (empty = fallback)
  "payload": {"type":"raw|escpos","encoding":"base64","data":"<base64 PDF or ESC/POS, 1..5MiB, canonical padded>"},
  "expiresAt?": "2026-09-01T12:00:00Z",
  "idempotencyKey?": "sale.order-42"
}
```
- Validates `validateOdooKey(req, branchId)` branch-scoped + `isOdooKeyAllowedForDocumentType` + `validatePrintJobPayload` (5 MiB `src/lib/payload.ts:6`; canonical padded base64 only) + `parseExpiresAt` future + `resolvePrinterForJob` (`src/lib/routing.ts:103` validates `branch` exists, `destination.branchId==branchId`, loads `printerBindings` `enabled` + `documentType` wildcard, sorts `priority`, iterates fallback, skips `disabled/offline/error`, validates `validatePayloadForPrinter` (now allows `raw/escpos` → `ipp/ipps` via `ipp.go`), checks `printer.branchId` & `agent.branchId` isolation, returns `fallbackChain`).
- Inserts `printJobs` `queued` (`branchId, destinationId, documentType, agentId, printerId, payload, requestedBy=odoo`), then `claimAndPushJobToAgent` (claim-before-delivery, see §5).
- → `201 {jobId,status,printerId,agentId,branchId,destinationId,documentType,fallbackUsed?,fallbackChain?}` where `status` is the **real** row status: `claimed` when the job was delivered to a connected agent, `queued` when it is waiting for the poll path. `200` with the existing job when `idempotencyKey` already exists (dedup is the `(branch_id, idempotency_key)` unique index; job ids are always full nanoids).
- Errors: `401` unauthorized, `403` forbidden (branch/documentType scope), `400` invalid, `404` `NO_PRINTER_FOUND`/`NO_ROUTE`/`INVALID_BRANCH|DESTINATION`, `409` `PRINTER_DISABLED`, `503` `PRINTER_OFFLINE`, `422` `CAPABILITY_MISMATCH`.

### Legacy: Direct Printer ID (preserved for migration)
`POST /api/print/jobs` `legacyBodySchema` `{"printerId","payload",...}` (`route.ts:13`) — validates printer exists+enabled+online, capability, `odoo.branchId != printer.branchId →403` branch isolation, same idempotency, inserts with `branchId=printer.branchId, requestedBy=odoo-legacy`.

### Status Polling
`GET /api/print/jobs?id=job_xxx&branchId=...` (Odoo key, branch-scoped) → `{jobId,status,printerId,agentId,branchId,destinationId,documentType,error,retries,expiresAt,updatedAt}`. `403` if `row.branchId != key.branchId`.

### Odoo Sync (bidirectional)
- `GET /api/odoo/agents?branchId=` / `GET /api/odoo/printers?branchId=` (Odoo key) — filtered by `branchId` or `odoo.branchId`, strips `secret`.
- `POST /api/odoo/sync` (Odoo key, branch-scoped) `src/app/api/odoo/sync/route.ts` — **validate everything first, then apply everything in ONE transaction**:
  1. authenticate the Odoo key and resolve exactly one branch scope (a payload mixing two branches is rejected as a whole);
  2. validate shape and branch ownership of every branch/destination/documentType/binding (all ids normalized to strings first, so Odoo integer ids and gateway text ids compare correctly);
  3. every binding must reference a destination that is either in the same payload or already in the gateway **and in the same branch**, and a printer that already exists **in the same branch**. Printers are owned by the gateway (agent registration/discovery) and are **never created from Odoo data**;
  4. only then `branches → destinations → documentTypes → bindings` are upserted inside a single `db.transaction`; any failure rolls the whole sync back.
  - Success → `200 {success:true, branchId, synced:{branches,destinations,documentTypes,bindings}, branches:[{id,action:"upserted"}], ...}`.
  - Invalid payload/ownership → `400 {success:false, error:"SYNC_VALIDATION_FAILED", branchId, details:[{entity,id,bindingId?,printerId?,destinationId?,reason}]}`.
  - Missing dependency (printer not registered yet, destination unknown) → `400 {success:false, error:"SYNC_DEPENDENCY_MISSING", details:[{bindingId,printerId,reason}]}` naming the missing object.
  - Branch-scoped key used for another branch → `403`; genuine DB failure → `500 {success:false, error:"SYNC_INTERNAL_ERROR"}` after a rollback.
  - Nothing is ever silently skipped and `{"success": true}` is never returned when part of the payload failed.
  - Ownership boundary: Odoo owns branches/destinations/document types/bindings; the gateway owns agents, printers and runtime status.
- `GET /api/odoo/sync?branchId=` — summary `{branchId, agents[50], printers[100], jobs[50]}` stripped.
- `GET /api/odoo/keys` / `POST /api/odoo/keys` (manager) for Odoo key lifecycle.

## Payload Contract (shared Go + TS)

```json
{ "type":"raw|escpos|pdf", "encoding":"base64", "data":"<base64 1..5MiB>" }
```
Both sides reject anything else (`agent/internal/payload/payload.go`, `src/lib/payload.ts`). The three types have **distinct, non-interchangeable semantics**:

| type | meaning | agent path | valid targets |
|------|---------|-----------|---------------|
| `raw` | opaque byte stream, printer-native | written verbatim to the transport | RAW TCP 9100, Windows spooler (RAW datatype), raw USB, IPP (`application/octet-stream`) |
| `escpos` | ESC/POS command stream (`ESC @` … `GS V`) | written verbatim to the transport | same as `raw` (ESC/POS is a payload dialect, not a transport) |
| `pdf` | a real PDF document (`%PDF-` … `%%EOF`, validated) | PDF pipeline: validate → secure temp file (0700 dir / 0600 file) → PDF-aware submission → wait → delete temp file | Windows spooler with a PDF handler / configured `pdf_print_command`, IPP (`application/pdf`) |

`pdf` is **never** renamed to `raw` and never written as an opaque byte stream. A PDF routed to a printer that cannot render it fails with `CAPABILITY_MISMATCH` (HTTP 422 at job creation; `job.status=failed`, `job.error=CAPABILITY_MISMATCH: …` if it is only detected on the agent). Odoo QWeb reports keep defaulting to `pdf`. Test payload `buildTestPrintPayload` = ESC/POS `\x1b\x40 Odoo Print Agent … \x1d\x56\x01`. Max 5 MiB enforced at the validation layer on both sides (no `Content-Length` guard before `req.json()`).

## Two Queue Layers

- Gateway PG: `queued → claimed → (delivery) → printing → success/failed/expired` (via `FOR UPDATE SKIP LOCKED` + `claimed_at`/`delivered_at`/`acked_at`/`delivery_attempts` + `retries`). The `claimed` state is entered by the gateway only — agents can never PATCH out of `queued` (`src/lib/job-status.ts`).
- Agent SQLite: `queued → printing → success/failed` (id == gateway job_id, `INSERT OR IGNORE`, WAL `agent/internal/queue/queue.go`). A job that already succeeded locally is never printed again on a duplicate delivery: the stored terminal result is re-reported instead. A locally *failed* job stays retryable, because a redelivery only happens after an explicit gateway reclaim that increments `retries`.
