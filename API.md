# Gateway API

The Odoo integration contract is intentionally small. Odoo owns business/routing intent; Gateway owns runtime agents, printers, queues, and physical execution.

## Authentication

### Agent
`Authorization: Bearer <agent-id>:<secret>`.

### Manager
`mgr_session` cookie or manager bearer session, according to `src/lib/manager-auth.ts`.

### Odoo
`Authorization: Bearer odoo_<key>` or `X-Api-Key: odoo_<key>` plus `X-Odoo-Database: <configured database>`.

The raw Odoo key is returned only at creation time. Gateway stores a cryptographic hash and revoke timestamp; list endpoints never return the secret.

## Health / Test Connection

### `GET /api/odoo/health`

Requires the Odoo installation API key and the configured `X-Odoo-Database` header. Returns `{ "ok": true }` only when authentication succeeds. This is the endpoint used by Odoo's **Test Connection** action.

## Odoo → Gateway

### `POST /api/print/jobs`

Request:

```json
{
  "printerId": "printer_abc",
  "documentType": "receipt",
  "destination": "Main POS",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "JVBERi0xLjQK..."
  },
  "idempotencyKey": "uuid-for-one-logical-print"
}
```

The contract has no Gateway branch identifier, branch synchronization, destination/document-type catalog, or Odoo runtime provisioning fields.

`201` means the Gateway accepted the durable runtime job. A repeated request with the same idempotency key is deduplicated instead of creating a second logical job.

Errors include `400` invalid request/payload, `401` authentication/database rejection, `404` unknown printer, `409` idempotency conflict, `422` capability mismatch, `429` rate limiting, `503` runtime unavailable, and `500` internal failure.

### `GET /api/print/jobs?id=<job-id>`

Returns Gateway runtime status. Branch parameters are not part of the Odoo contract.

## API key lifecycle

### `GET /api/odoo/keys`
Manager-authenticated metadata only.

### `POST /api/odoo/keys`
Manager-authenticated. The response contains the raw `apiKey` once and explicitly instructs the user to copy it.

### `DELETE /api/odoo/keys`
Manager-authenticated. Revokes the key by ID; subsequent authenticated requests fail.

## Agent runtime APIs

Agent registration, heartbeat, polling, WebSocket delivery, and job progress are runtime endpoints owned by Gateway. Runtime agent/printer records are never created by Odoo configuration APIs.

## Removed contracts

The following Odoo-facing APIs were removed from the architecture:

- `POST /api/odoo/sync`
- `GET /api/odoo/agents`
- `GET /api/odoo/printers`
- branch-scoped Odoo API-key authorization
- Gateway-branch routing payloads
- Odoo synchronization of Gateway branches, destinations, document types, agents, or printers
