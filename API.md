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
Odoo key scopes are strictly `standard` or `read_only`; `read_only` cannot create print jobs.
Agents are scoped to their own id and branch.

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

`expiresAt` and `idempotencyKey` are optional. Without `expiresAt` the default job TTL is 1 hour;
explicit `expiresAt` values may be at most 24 hours in the future. `documentType` is matched
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

**200 OK** — idempotency hit: the existing job is returned unchanged (same `jobId`) only when
its branch-routed destination/document type and payload, or its legacy printer and payload,
match the original request.

**409 Conflict** — `IDEMPOTENCY_CONFLICT`: the same branch-scoped idempotency key was already
used for a different logical print request. The caller must generate a new idempotency key for
a new print operation; this response is not retryable with the same key.

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{"error":"…"}` | invalid JSON/body, invalid payload, `expiresAt` not ISO-8601/not in the future/exceeds the 24 h maximum, `INVALID_BRANCH`, `INVALID_DESTINATION` |
| 401 | `{"error":"Unauthorized (invalid branch-scoped Odoo API key)"}` | unknown/revoked key or wrong branch |
| 403 | `{"error":"API key is not allowed to create this document type"}` | `allowedDocumentTypes` / `read_only` scope; legacy path also 403 on cross-branch printer |
| 404 | `{"error":"NO_ROUTE: …"}` / `NO_PRINTER_FOUND` | no matching binding / no printer row |
| 409 | `{"error":"IDEMPOTENCY_CONFLICT","code":"IDEMPOTENCY_CONFLICT","retryable":false}` | same idempotency key reused with different request; or administratively invalid printer state |
| 422 | `{"error":"CAPABILITY_MISMATCH: …","code":"CAPABILITY_MISMATCH"}` | payload type cannot be rendered by the routed printer |
| 503 | `{"error":"PRINTER_OFFLINE: …","code":"PRINTER_OFFLINE"}` | candidates are offline/error |
| 500 | `{"error":"INTERNAL_ERROR: …"}` | routing/database failure (never disguised as 404) |

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

No auth (the pairing code is the credential). The registration request cannot establish ownership.

```json
{ "agentId": "agt_7f3c", "pairingCode": "AB12CD",
  "metadata": {"hostname":"pos-pc-1","os":"windows","version":"1.0.0"} }
```

`branchId` is forbidden. The Gateway resolves the existing Agent by `agentId`/pairing code and returns
that Agent's authoritative `branchId`. Disabled and retired Agents cannot register.

**200** `{"agentId":"agt_7f3c","branchId":"branch_cairo","secret":"<shown once>"}` — only the SHA-256 hash is stored.
400 invalid/expired/unknown ownership input, 409 a racing or already-consumed code, 500 internal error.

### `POST /api/agent/heartbeat`

Auth: agent. Sent every 30 s.

```json
{ "status": "online",
  "printers": [
    { "id":"printer_spooler_9ab1", "name":"HP LaserJet",
      "printerType":"physical", "deviceClass":"laser", "connectionType":"spooler", "protocol":"spooler",
      "status":"online",
      "config":{"spooler_name":"HP LaserJet"},
      "capabilities":{"supported_protocols":["raw","escpos","pdf"]} } ] }
```

Updates `agents.status`/`lastSeenAt` and upserts each printer **scoped to the calling
agent** — a printer row owned by another agent is skipped, never overwritten. Lifecycle is
operator-controlled and is never re-enabled by heartbeat. The canonical printer model is
`printerType + connectionType + protocol`; legacy `type`/`config.protocol` may be parsed only at
compatibility input boundaries and are not stored or returned as canonical fields. The printer
branch is always derived from the calling Agent's authoritative branch.

**200** `{"success":true,"skippedPrinters":["printer_x"]}`. 401 unauthenticated, 500 internal.

### `GET /api/agent/jobs` — claim work (poll path)

Auth: agent. In one request the gateway:

1. expires this agent's non-terminal jobs whose `expires_at` has passed;
2. recovers stale claims within the retry budget;
3. claims a bounded batch under the per-Agent in-flight limit;
4. returns only jobs belonging to this authenticated Agent/branch.

The Gateway also uses the same claim service when PostgreSQL notifications trigger WebSocket
push delivery.

---

## Notes on job semantics

The Gateway's persisted job is the durable print-delivery record. An idempotency key identifies
one logical print operation within a branch; it is intentionally not derived from the report name,
record id, or current time. Reusing a key with materially different routing inputs or payload is
an `IDEMPOTENCY_CONFLICT` and must not silently reuse the original job.

The Agent's terminal `success` means the bytes were accepted by the configured printer transport.
For RAW TCP this is a successful socket write; it does not prove that paper physically exited the
device. Device/spooler feedback is required for stronger physical-outcome semantics.
