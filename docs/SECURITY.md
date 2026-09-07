# Security Model

## Authentication domains

| Domain | Credential | Purpose |
|---|---|---|
| Agent | `Bearer <agent-id>:<secret>` | Agent runtime APIs |
| Manager | manager session cookie/bearer | Gateway administration |
| Odoo | `Bearer odoo_<key>` or `X-Api-Key` + `X-Odoo-Database` | Odoo integration API |

Raw Odoo API keys are returned only when generated. Gateway stores only the cryptographic hash and a revoke timestamp.

## Odoo API keys

The key is installation-level, not branch-scoped and not document-type-scoped.

- Generate from the Gateway manager.
- Copy the raw key once.
- Gateway list/read endpoints return metadata only.
- Revoke by key id; revoked keys immediately fail authentication.
- `X-Odoo-Database` binds the key to the configured Odoo database/installation.

No branch id is encoded in the Odoo key authorization model.

## Gateway URL / SSRF protection

Odoo Gateway URLs are validated before storage and before requests:

- HTTP or HTTPS only.
- Host required.
- No embedded credentials.
- No query string or fragment.
- Origin only; no API path.
- Newlines and oversized values rejected.
- Local/private/loopback/link-local/reserved targets rejected unless explicitly allow-listed by deployment configuration.
- Requests use `allow_redirects=False` so the configured origin cannot silently redirect to another host.

## Odoo permissions

Gateway configuration and binding mutation are restricted to Odoo system administrators.
Read access is company-scoped by Odoo record rules. Print-job history is company-scoped as well.
The module has no custom ACL for branches, agents, printers, destinations, or document catalogs because those models are not part of the addon.

## Print safety

When Gateway printing is enabled, a routing/submission/rendering failure is fail-closed:

```text
Gateway enabled + error -> visible error
Gateway disabled -> native Odoo printing
```

There is no silent browser/native fallback in the Gateway-enabled path.

## Secret and log handling

The addon never logs API keys or payload contents. Gateway manager endpoints return only redacted runtime metadata. Agent secrets are protected according to the Agent host implementation.

Errors should expose machine-readable failure categories but never credentials or payload bytes.

## Replay and idempotency

One Odoo logical print operation gets one persisted idempotency key. Odoo retries reuse the same key. Gateway job creation uses its own unique idempotency constraint and returns the existing job on a duplicate request.

Physical printing is still subject to the fundamental unknown-outcome boundary: if the device receives bytes before the connection fails, the final physical state cannot be inferred solely from HTTP success/failure.

## Rate limiting

Gateway print submission continues to use distributed queue and rate limits. Odoo does not attempt to implement a second runtime queue or runtime printer scheduler.

## Runtime isolation

Gateway/Agent runtime state—agent ownership, printer status, queue claims, WebSocket delivery, and discovery—is owned and enforced by the Gateway. It is not synchronized into Odoo as duplicate runtime-management models.
