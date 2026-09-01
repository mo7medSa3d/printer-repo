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
`GET /api/agent/jobs` (agent auth) — does TTL sweep, fail stale >90s retries>=5, then `WITH claimable ... FOR UPDATE SKIP LOCKED` claims `queued` + reclaimable `claimed/printing` up to 20, `RETURNING id,printerId,payload,expiresAt,retries`. Two pollers never get same job. Scoped by `agent.branchId` (`branchFilter`).

### 4. Update Job Status
`PATCH /api/agent/jobs` (agent auth) `{"jobId","status":"printing|success|failed|expired","error?"}`
- TTL wins: if `expiresAt <= now()` and not terminal → 409 `expired`.
- `canTransition` `src/lib/job-status.ts:34`: `claimed→{printing,failed,expired}`, `printing→{success,failed,expired}`, terminal blocks.
- Scoped to `agentId` + `branchId`; 404 if job belongs to other agent.

### 5. WebSocket (Agent only)
`WSS /api/agent/ws` — handled in `server.ts` + `src/server/ws.ts` (Next route returns 426). Upgrade with `Authorization: Bearer agt:secret`. Server validates then `attachAgentWSS` tracks `Map<agentId,Set<WS>>`, ping/pong 30s, `broadcastJobToAgent` on job creation. Desktop **does not** use WS — polls HTTPS.

**Push claim semantics:** job creation paths use `pushJobToAgentWithClaim` (`src/server/ws.ts`). If (and only if) an open socket received the push, the job row is atomically moved `queued→claimed` (racing polls collapse to a 0-row no-op) — this grants the WS-delivered agent the same PATCH lease the poll path would establish. A failed push (no open socket) leaves the job `queued` for the agent's poll fallback.

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
- Inserts `printJobs` `queued` (`branchId, destinationId, documentType, agentId, printerId, payload, requestedBy=odoo`) + `pushJobToAgentWithClaim` via WS.
- → `201 {jobId,status:"queued",printerId,agentId,branchId,destinationId,documentType,fallbackUsed?,fallbackChain?}` or `200` if `idempotencyKey` hit (`job_<hash(odooId:key).slice(0,10)>`).
- Errors: `401` unauthorized, `403` forbidden (branch/documentType scope), `400` invalid, `404` `NO_PRINTER_FOUND`/`NO_ROUTE`/`INVALID_BRANCH|DESTINATION`, `409` `PRINTER_DISABLED`, `503` `PRINTER_OFFLINE`, `422` `CAPABILITY_MISMATCH`.

### Legacy: Direct Printer ID (preserved for migration)
`POST /api/print/jobs` `legacyBodySchema` `{"printerId","payload",...}` (`route.ts:13`) — validates printer exists+enabled+online, capability, `odoo.branchId != printer.branchId →403` branch isolation, same idempotency, inserts with `branchId=printer.branchId, requestedBy=odoo-legacy`.

### Status Polling
`GET /api/print/jobs?id=job_xxx&branchId=...` (Odoo key, branch-scoped) → `{jobId,status,printerId,agentId,branchId,destinationId,documentType,error,retries,expiresAt,updatedAt}`. `403` if `row.branchId != key.branchId`.

### Odoo Sync (bidirectional)
- `GET /api/odoo/agents?branchId=` / `GET /api/odoo/printers?branchId=` (Odoo key) — filtered by `branchId` or `odoo.branchId`, strips `secret`.
- `POST /api/odoo/sync` (Odoo key, branch-scoped) `src/app/api/odoo/sync/route.ts:18` idempotent upsert `branches, destinations, documentTypes, bindings` by `id` (update or insert), rejects `branch mismatch`, returns `{success:true, branches:[{id,action}], ...}`.
- `GET /api/odoo/sync?branchId=` — summary `{branchId, agents[50], printers[100], jobs[50]}` stripped.
- `GET /api/odoo/keys` / `POST /api/odoo/keys` (manager) for Odoo key lifecycle.

## Payload Contract (shared Go + TS)

```json
{ "type":"raw|escpos", "encoding":"base64", "data":"<base64 1..5MiB>" }
```
Both sides reject otherwise (`agent/internal/payload/payload.go:43`, `src/lib/payload.ts:5`). For PDF reports, `raw` carries PDF bytes (`%PDF-...`); for thermal, `escpos` carries `ESC @` init + `GS V` cut. Test payload `src/lib/payload.ts:37` = `\x1b\x40 Odoo Print Agent ... \x1d\x56\x01`. Max 5 MiB enforced at validation layer only (no `Content-Length` guard before `req.json()`).

## Two Queue Layers

- Gateway PG: `queued → claimed → printing → success/failed/expired` (via `FOR UPDATE SKIP LOCKED` + `claimedAt` + `retries`)
- Agent SQLite: `queued → printing → success/failed` (id == gateway job_id, `INSERT OR IGNORE`, WAL `agent/internal/queue/queue.go:14`)
