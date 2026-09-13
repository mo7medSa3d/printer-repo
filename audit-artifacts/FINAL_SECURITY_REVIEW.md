# FINAL_SECURITY_REVIEW.md (independent of functionality)

## Authentication (verified in code)
- Agent: `Bearer id:secret` (192-bit secret, sha256 at rest, timing-safe compare, lifecycle gate). Pairing: 6-char/30-bit single-use 10-min codes, escalating per-IP lockout; WEAKNESSES: unsalted hash, no pending-code uniqueness → migration 0032 added (this cycle). Widening to 8 chars deferred (3-language contract).
- Odoo: `odoo_*` 256-bit keys, hash-only storage, revoke-before-delete, per-key doc-type scope, cross-key isolation on reads; rotation-during-flight strands sync (documented).
- Manager: HS256 JWT (pinned header, exp/iat/jti checks) + DB-backed revocation, scrypt password, single shared credential (documented limitation), HttpOnly/Secure/Lax cookie + desktop bearer; DB-backed login/pairing/WS-upgrade rate limits shared across instances.
- CSRF: no token-based bypass (bearer is explicit header); cookie flows are SameSite=Lax + JSON APIs.

## Authorization (every sensitive op checked)
All 28 routes + all server actions gate on validateManager/validateAgent/validateOdooKey + tenant predicates incl. composite FKs; Odoo model ACLs are read-only for users with sudo only inside documented service boundaries + read checks at every exfil boundary. No IDOR found (IDs assumed known by design).

## Transport (corrected this cycle)
Reference stack = Caddy TLS as sole public edge. Plaintext HTTP accepted by Odoo+agent by design (zero-config); docs now state this truthfully with credential-in-transit warnings. WS uses same TLS as gateway URL; no insecure TLS flags anywhere (`InsecureSkipVerify` absent). HSTS via Next headers in production.

## Secrets
No committed secrets (verified: `.env` gitignored, placeholders only). Placeholder refusal added for JWT/proxy secrets at production boot. Agent secret DPAPI-sealed + hardened ACLs; pairing secret never logged (log key redaction incl. `payload`); Odoo key masked in UI.

## Residual risks (accepted, documented)
Single shared manager credential; http-by-default on LAN; 6-char pairing codes; sessionStorage bearer in desktop webview; link-local device IPs accepted for mDNS reality.
