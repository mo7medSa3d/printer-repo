# Gateway API

The Odoo integration contract is intentionally small. Odoo owns business records, destination/report context, bindings and print intent. Gateway owns runtime agents, printers, queues and physical execution.

## Authentication

### Agent
`Authorization: Bearer <agent-id>:<secret>`.

### Manager
`mgr_session` cookie or manager bearer session, according to `src/lib/manager-auth.ts`.

### Odoo
`Authorization: Bearer odoo_<key>` or `X-Api-Key: odoo_<key>` plus `X-Odoo-Database: <configured database>`.

The raw Odoo key is returned only when generated. Gateway persists only its cryptographic hash and a revoke timestamp.

## `GET /api/odoo/health`

Authenticated with the Odoo installation key and configured database name. Returns `{ "ok": true }` only for a valid, non-revoked key. This endpoint is used by the Odoo **Test Connection** button.

## `GET /api/odoo/printers`

Authenticated with the same Odoo installation key. Returns a sanitized list of non-retired runtime printers and agent display information. This is read-only runtime discovery for the Odoo Print Binding selector; the endpoint never creates or changes printers and does not return agent secrets.

## `POST /api/print/jobs`

Request:

```json
{
  "printerId": "runtime-printer-id",
  "documentType": "receipt",
  "destination": "Main POS",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "JVBERi0xLjQK..."
  },
  "expiresAt": "2026-09-07T15:00:00Z",
  "idempotencyKey": "stable-for-one-logical-print"
}
```

No Gateway branch ID, Gateway destination ID, Gateway document-type ID, agent provisioning data, or printer-creation data is accepted.

The Gateway validates the Odoo key, database binding, payload, expiration and idempotency before queueing the runtime job.

`201` means a new job was accepted. `200` means an idempotent retry matched an existing job and returns that job identity. A reused key with different routing/payload data returns `409 IDEMPOTENCY_CONFLICT`.

Typical failures include `400` invalid input, `401` authentication failure, `404` unknown runtime printer, `422` capability mismatch, `429` rate limit, `503` runtime/queue availability failure and `500` internal failure. Gateway-enabled Odoo printing never converts these failures into browser/native printing.

## `GET /api/print/jobs?id=<jobId>`

Authenticated with the Odoo installation key. Returns the runtime status and routing identifiers for the requested job. This endpoint is for Odoo print-job reconciliation and status display.

## Runtime ownership boundary

Gateway APIs for Branches, business destinations, business document catalogs and Odoo-to-Gateway business synchronization are intentionally absent. Agents register runtime resources with Gateway; Odoo references those runtime printers only when creating bindings.

## Reliability contract

The Odoo addon commits a durable outbox row before making the HTTP submission. The same idempotency key is reused for retry attempts of that logical operation. Network timeouts are recorded as an unknown physical outcome instead of a definite failure. Gateway-side idempotency ensures reconciliation does not create a second logical job.
