# Security Model

## Authentication domains

| Domain | Credential | Purpose |
|---|---|---|
| Agent | `Bearer <agent-id>:<secret>` | Agent runtime APIs |
| Manager | manager session cookie/bearer | Gateway administration |
| Odoo | `Bearer odoo_<key>` or `X-Api-Key` | Odoo integration API |

Raw Odoo API keys are returned only when generated. Gateway stores only the cryptographic hash and a revoke timestamp.

Odoo Gateway authentication is based on the Odoo installation API key. The Odoo database name is not used as an authentication requirement.

## Odoo API keys

The key is installation-level (one installation shares one scope of keys), not
branch-scoped. Keys DO carry an authorization model: `scope` (`standard` |
`read_only`) and an optional `allowedDocumentTypes` allowlist enforced on
every submission and status read (`isOdooKeyAllowedForDocumentType`).

- Generate from the Gateway manager.
- Copy the raw key once.
- Gateway list/read endpoints return metadata only.
- Revoke by key id; revoked keys immediately fail authentication.
- `X-Odoo-Database` may be sent for informational purposes; it is ignored for authentication.

No branch id is encoded in the Odoo key authorization model.

## Gateway URL / SSRF posture

Odoo Gateway URLs are validated before storage and before requests:

- HTTP or HTTPS only.
- Host required.
- No embedded credentials.
- No query string or fragment.
- Origin only; no API path.
- Newlines and oversized values rejected.
- Requests use `allow_redirects=False` so the configured origin cannot silently redirect to another host.

What is NOT enforced (deliberate zero-config design — do not mistake the
absence for a bug, but do not deploy as if the check existed either):
local/private/loopback/link-local targets ARE accepted
(`test_gateway_url_transport.py` pins this). The operative control is that
only system administrators (`base.group_system`, plus model-level
`_check_admin` on every mutation) can set the URL. Deployments that must
reach the gateway from sensitive networks should terminate the Odoo→Gateway
leg at a proxy and pin `https://` operationally.

## Odoo permissions

Gateway configuration and binding mutation are restricted to Odoo system administrators.
Read access is company-scoped by Odoo record rules. Print-job history is company-scoped as well.
The module has no custom ACL for branches, agents, printers, destinations, or document catalogs because those models are not part of the addon.

## Print safety

When Gateway printing is enabled, a routing/submission/rendering failure is fail-closed:

```text
Gateway enabled + binding exists + error -> visible error, native cancelled
Gateway enabled + NO binding for this destination -> native Odoo download
Gateway disabled -> native Odoo printing
```

Bound routes never silently bypass to the browser. Unbound destinations fall
back to the native download by design (`report_download_override` returns
`super()` when no binding resolves) — operators auditing "no print left the
browser" must read this as *per binding*, not global.

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
