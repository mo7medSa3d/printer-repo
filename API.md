# API — Gateway (Next.js, `server.ts` custom WS)

## Auth Domains (separate)

- **Agent:** `Authorization: Bearer <agentId>:<secret>` (SHA256 hash server-side, timing-safe). Use for `POST /api/agent/*`, `GET/PATCH /api/agent/jobs`, `WS /api/agent/ws`. See `src/lib/agent-auth.ts`.
- **Manager:** `Cookie: mgr_session=<JWT>` (httpOnly, 8h, `jti` server row `manager_sessions`) or `Authorization: Bearer <jwt>`. Use for `GET /api/agents|printers|jobs`, `POST /api/printers/*`, `POST /api/odoo/keys`. See `docs/AUTH.md`, `src/lib/manager-auth.ts`.
- **Odoo:** `Authorization: Bearer odoo_xxx` or `X-Api-Key: odoo_xxx` (SHA256 `api_keys.hashedKey`). Use for `POST /api/print/jobs`. See `src/lib/odoo-auth.ts`.

## Agent ↔ Gateway

### 1. Register (Pairing)
`POST /api/agent/register` (no auth) `src/app/api/agent/register/route.ts:7`
```json
{ "pairingCode": "AB12CD", "metadata": {"hostname":"pc-1","os":"windows","version":"1.0.0"} }
```
→ `200 {agentId, secret}` — secret shown once, stored hashed. Code 6 chars, uppercase, 30m, single-use with race check.

### 2. Heartbeat (Agent → Gateway only)
`POST /api/agent/heartbeat` (agent auth)
```json
{ "status":"online", "printers":[{"id":"printer_receipt","name":"Receipt","type":"network","status":"online","config":{"ip":"192.168.1.50","port":9100,"protocol":"escpos"}}] }
```
Server upserts `agents.lastSeenAt` and `printers` scoped to `agent.id` (cannot overwrite other agent's printer).

### 3. Poll Jobs (atomic lease)
`GET /api/agent/jobs` (agent auth) — does TTL sweep, fail stale >90s retries>=5, then `WITH claimable ... FOR UPDATE SKIP LOCKED` claims `queued` + reclaimable `claimed/printing` up to 20, `RETURNING id,printerId,payload,expiresAt,retries`. Two pollers never get same job.

### 4. Update Job Status
`PATCH /api/agent/jobs` (agent auth) `{"jobId","status":"printing|success|failed|expired","error?"}`
- TTL wins: if `expiresAt <= now()` and not terminal → 409 `expired`.
- `canTransition` `src/lib/job-status.ts:34`: `claimed→{printing,failed,expired}`, `printing→{success,failed,expired}`, terminal blocks.
- Scoped to `agentId`; 404 if job belongs to other agent.

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
- `GET /api/printers` / `POST /api/printers` / `GET/PATCH/DELETE /api/printers/:id` — validates `ip:port`, `type`, `protocol` (`zod` + `config.ValidatePrinterConfig`)
- `POST /api/printers/:id/test-connection` — **RPC, no job row** `src/app/api/printers/[id]/test-connection/route.ts:1` → `{reachable, latencyMs, agentOnline, error}`
  - **Explicit semantics (final gate):** Preferred `Tauri→Gateway→Agent→immediate TCP dial/probe→measured latencyMs→Gateway→Tauri` (Agent `NetworkPrinter.Status` 2s / DialContext 5s). Current `latencyMs:null` is **cached** from last heartbeat `printer.status` because Gateway cannot dial LAN; file header documents next-phase live WS probe `{type:"probe",printerId}`. `probeId` only if tracing required — not used. `test-connection` never touches `printJobs` (grep verified).
- `POST /api/printers/:id/test-print` — **real job** `buildTestPrintPayload` → `createPrintJob` → `queued → claimed(lease) → printing → success/failed` + claim-aware WS push (`pushJobToAgentWithClaim`)
- `GET /api/jobs?status=&printerId=&agentId=&limit=` / `GET /api/jobs/:id` (manager read) — filters applied in SQL `WHERE` before `LIMIT`; unknown `status` → `400`
- `GET /api/odoo/keys` / `POST /api/odoo/keys` (manager)

## Odoo → Gateway

- `POST /api/print/jobs` (Odoo key) `{"printerId","payload":{type:"raw|escpos",encoding:"base64",data:"..."},"expiresAt?","idempotencyKey?"}`
  - Validates printer exists+enabled, `validatePrintJobPayload` (5 MiB cap `src/lib/payload.ts:6`; **canonical, padded base64 only** — matches the agent's strict `base64.StdEncoding`; unpadded or out-of-alphabet input → `400`), `expiresAt` future, idempotency via `job_<hash>` if `idempotencyKey` provided.
  - Inserts `printJobs` `queued`, `pushJobToAgentWithClaim` to Agent via WS (polling fallback for offline/unconnected agents).
  - → `201 {jobId,status:"queued",printerId,agentId}` or `200` if idempotent hit.
- `GET /api/print/jobs?id=job_xxx` (Odoo key) → `{jobId,status,printerId,agentId,error,retries,expiresAt,updatedAt}`

## Payload Contract (shared Go + TS)

```json
{ "type":"raw|escpos", "encoding":"base64", "data":"<base64 1..5MiB>" }
```
Both sides reject otherwise (`agent/internal/payload/payload.go:43`, `src/lib/payload.ts:5`). Test payload `src/lib/payload.ts:18` = `\x1b\x40 Odoo Print Agent ... \x1d\x56\x01`.

## Two Queue Layers

- Gateway PG: `queued → claimed → printing → success/failed/expired`
- Agent SQLite: `queued → printing → success/failed` (id == gateway job_id, `INSERT OR IGNORE`, WAL `agent/internal/queue/queue.go:14`)
