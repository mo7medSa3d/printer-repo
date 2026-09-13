# FINAL_ARCHITECTURE_MAP.md (reconstructed from code)

## Processes & trust boundaries
1. **Odoo 19 + print_gateway addon** (Python, business trust domain). Owns companies/branches, documents, bindings, intents, durable outbox. Talks to gateway over HTTPS as a *client* with installation API key. System-admin-only configuration.
2. **Gateway** (Next.js 16 custom `server.ts`, Node 24). Owns agents registry, runtime printers, queue/claims/delivery, manager console. Trusts: Caddy proxy token (header trust), agent bearer `id:secret`, Odoo `odoo_*` key (sha256, per-key doc-type scope), manager HS256 session cookie/bearer + DB jti.
3. **PostgreSQL 16**. Ownership truth: composite `(tenant_id, id)` FKs; closed CHECK vocabularies; claim fencing predicates; partial idempotency uniques. Single clock domain (`now()`).
4. **Windows Go agent** (service). Owns physical execution + SQLite WAL ledger (claim_token, crash markers). Holds NO authority over routing; echoes claim tokens; bounded executor (8 exec/64 pending); LAN discovery limited to private CIDR; secrets DPAPI-sealed + hardened ACLs.
5. **Tauri 2 desktop** (per-machine NSIS). Manager UI shell; origin-pinned `gateway_request` IPC; manager bearer in sessionStorage; single-instance NOT enforced (P3).
6. **Caddy 2** (sole public edge). TLS, 8 MiB body cap, proxy-token injection, XFF overwrite.

## Dependency graph (calls →)
UI/console → server actions + manager REST → `print-job-service` → advisory-locked atomic insert → `claimAndPushJobToAgent` → `ws.sendToAgent` → evidence write. Agent WS/poll → claim → ledger `BeginPrint` (precondition) → transport → fenced terminal PATCH → gateway sweep → Odoo cron sync (batch-status → per-job fallback) → chatter audit. Discovery: manager → session row → agent 30 s poll → bounded scan → candidate rows → manager verify → provision (transport allow-list; LPR refused). Metrics: per-request DB counters + fleet gauges → platform-gated Prometheus endpoint.
