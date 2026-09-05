# Production readiness

## Verdict

**NOT PRODUCTION-READY FROM THE VERIFIED SCOPE.**

The software now has explicit discovery approval, server-side job expiry/recovery, early request-size checks, database discovery-state constraints, and deployment-safe migration semantics. Physical printing, live Odoo, Windows/Tauri, and real network printers still require environment-specific verification before a production claim.

## Current software gates

| Area | State |
|---|---|
| PostgreSQL migrations/invariants | CI gate; migrations are applied before integration tests |
| Node typecheck/lint/build | CI gate |
| Node unit/integration tests | CI gate |
| Go vet/tests/race | CI gate |
| Odoo 19 addon runtime tests | CI gate using Odoo 19 Community |
| Windows/Tauri packaging | Windows CI gate |
| Physical printer E2E | Requires real hardware and operator verification |

## Discovery trust model

Discovery reports are observations from an authenticated agent. The Gateway does **not** accept an agent-supplied `verification=verified` or confidence value as authorization evidence; incoming observations are persisted as `candidate/low`.

A manager must explicitly approve a candidate through the discovery verification endpoint before it can be provisioned into the operational `printers` table. Live document-format capability verification remains an agent/runtime concern and is not fabricated by the Gateway.

Only private IPv4 ranges (RFC1918 plus IPv4 link-local) and IPv6 unique-local/link-local addresses are accepted in discovery reports. Public, loopback, multicast, unspecified, malformed, and zone-indexed IPv6 addresses are rejected.

## Job reliability

Job TTL and stale-lease recovery no longer depend on an agent calling `/api/agent/jobs`. The custom server runs an independent maintenance loop every 30 seconds. Agent polling also invokes the same idempotent sweep, so recovery remains active during normal operation and when an individual agent is offline.

Physical printing remains **at-least-once**. A crash after bytes reach a printer but before durable status recording can leave an ambiguous physical outcome. Exactly-once physical printing is not claimed.

## Deployment hardening

The Docker image no longer runs `db:migrate` during application startup. Migrations are a dedicated release/deployment step, allowing application replicas to run without requiring schema-write privileges.

Authentication-rate-limit and expired-manager-session retention cleanup run from server housekeeping rather than on the manager-login hot path.

The legacy direct-printer print endpoint remains only for compatibility and now requires a branch-scoped Odoo key, a live/enabled branch, branch ownership of the target printer, and the same canonical payload validation used by routed printing. New integrations should use branch/destination/document-type routing.

HTTP endpoints now reject an oversized declared `Content-Length` before JSON parsing. Chunked request limits must still be enforced by the trusted reverse proxy/load balancer.

## Known production gates that remain open

1. Real Windows spooler/USB printing and Tauri install/tray/service verification.
2. Real IPP and RAW/ESC-POS printer tests on representative hardware.
3. Live Odoo end-to-end validation from Odoo document creation to physical page output.
4. Production TLS/proxy configuration, backups, monitoring, and incident/reprint policy.
5. Windows code signing for production-distributed installers.
6. GitHub `main` branch protection/ruleset configuration requiring PR review and successful CI/Windows checks. The current repository branch metadata reports `main` as unprotected.

## Go/no-go checklist

- [ ] Production database migrations completed successfully before application rollout
- [ ] `GATEWAY_JWT_SECRET` >= 32 random characters
- [ ] `MANAGER_PASSWORD_HASH` configured; plaintext manager password disabled
- [ ] TLS termination and WebSocket upgrade configured at the trusted proxy
- [ ] Branch-scoped Odoo keys issued; document-type allow-lists configured where appropriate
- [ ] Discovery candidates reviewed/approved before provisioning
- [ ] Representative PDF/RAW/ESC-POS paths proven on required printer models
- [ ] Windows physical E2E procedure completed, including deliberate-failure testing
- [ ] Database backups, monitoring, and stuck-job alerts configured
- [ ] Windows installers signed for the intended production distribution channel
- [ ] `main` protected with required checks/review policy

Until the environment-dependent items above are completed, the honest status remains **NOT PRODUCTION-READY FROM THE VERIFIED SCOPE**.
