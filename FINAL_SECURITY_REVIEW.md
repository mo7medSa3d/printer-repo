# Final Security Review

## Overall
**Security posture: improved, but not certifiable.**

## High-priority findings

### HIGH — runtime security test campaign is not executable in this environment
The code contains tenant checks and centralized permission checks, but dynamic BOLA/IDOR, session abuse, pairing replay, SSRF, WS flooding, and payload abuse were not executed against a live stack.

### HIGH — desktop token bootstrap pattern needs redesign before enterprise use
The Manager login path has a `X-Odoo-Print-Desktop: 1` client marker. That marker is not an authentication factor by itself. The login contract still requires the actual credential flow, but the marker must never be treated as proof of trusted application identity.

### HIGH — Windows physical execution security is unverified
LocalSystem, Session 0, executable invocation, filesystem ACLs, driver interactions and spooler behavior cannot be certified without Windows execution.

## Medium findings

- PostgreSQL RLS is not yet enabled. Current docs state RLS is an additional row-security wall and defaults to deny when enabled without policy, with owner/superuser bypass considerations. citeturn639871search5turn639871search7
- Audit writes are currently best-effort in several action paths (`void ...catch()`), so auditability can degrade if the database is unavailable. This is operationally weaker than committing critical security audit events in the same transaction as the protected state change.
- Legacy Manager bootstrap credentials remain transitional and should be formally deprecated in favor of user/membership identity.

## Security strengths observed

- Tenant is now part of authenticated Manager session state and is revalidated against membership.
- Host is no longer sufficient to choose a tenant for legacy global credentials.
- Central permission policy exists and is used by important server actions/routes.
- Production `src` has no `as any` occurrences.
- Agent/Odoo credentials are conceptually separated from human Manager identity.
- Integration key rotation and revocation are present.
- Print job payload validation/capability validation is present before queue insertion.
- Claim token fencing and idempotency are already part of the runtime design.

OWASP API Security Top 10 specifically calls out Broken Object Level Authorization and Broken Authentication as primary API risks, which matches the negative-test focus applied here. citeturn639871search9

## Final security classification
`PARTIALLY HARDENED — NOT VERIFIED FOR PRODUCTION`
