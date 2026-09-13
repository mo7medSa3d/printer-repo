# FINDINGS_LEDGER — audit cycle 2 (2026-09-13)
| ID | Sev | Category | Location | Finding (verified, not hypothetical) | Action |
|---|---|---|---|---|---|
| P1-01 | P1 | DevOps/process | git worktree | Entire tenant-isolation patch (45 modified + 16 untracked incl. migrations 0030/0031, edited 0029) uncommitted; CI never executed it | PRESERVE + document (rule: never discard user work; commit is a user decision) |
| P1-02 | P1 | Perf/PII | src/app/dashboard/page.tsx:53, src/app/actions.ts getDashboardState | 50 full job rows incl. multi-MB base64 payload shipped to browser and re-fetched every 3–6 s poll | FIXED: payload removed from list queries (metadata-only) |
| P1-03 | P1 | Security-docs | docs/PRODUCTION_TLS.md:9-11, docs/SECURITY.md:37, docs/DEPLOYMENT.md:68, ARCHITECTURE.md:158, docs/PRODUCTION_READINESS.md:33, agent/configs/config.yaml.example | Docs claim http:// + private/loopback gateway URLs are rejected / "SSRF controls" — code deliberately accepts all (gateway_config.py:63, config.go:68-71, tests assert 127.0.0.1/192.168 accepted) | FIXED: docs corrected to actual behavior + explicit plaintext-credential risk warning |
| P2-01 | P2 | Deadlock | odoo print_job.py _handle_pre_dispatch_failure (failover job.write @ ~728) + _persist_state (2nd cursor) | raise_on_failure submit path can self-deadlock (C1 uncommitted row lock vs C2 UPDATE); invisible to PG | FIXED: failover write goes through _persist_state in raise path + defensive SET LOCAL lock_timeout in _persist_state |
| P2-02 | P2 | Security | api/agent/register + agents.pairingCodeHash | 30-bit codes, unsalted SHA-256, no DB uniqueness of pending hash | PARTIALLY FIXED: new migration 0032 = guarded UNIQUE partial index (fail-loud, no data deletion). Code-length/HMAC change deferred (3-language contract) — documented |
| P2-03 | P2 | Observability | api/metrics/route.ts PLATFORM_TENANT_ID | required env var undocumented everywhere → metrics 403 in practice | FIXED: documented (OPERATIONS, DEPLOYMENT, .env.example) |
| P2-04 | P2 | Dead schema | users/tenant_users/applications tables, withTenant(), backfill stub user "unmigrated-legacy-password" | advertised-but-unenforced identity model | DOCUMENTED (removal = data-destructive decision for owners) |
| P2-05 | P2 | Reliability | server.ts | no SIGTERM drain → mid-deploy resets map to UNKNOWN_SUBMISSION_OUTCOME in Odoo | FIXED: graceful shutdown (stop accept, close WS 1001, clear timers, 10 s hard-exit backstop) |
| P2-06 | P2 | Secrets | .env.example TRUST_PROXY_SECRET/GATEWAY_JWT_SECRET placeholders pass >=32 check | known placeholder in production defeats IP-trust controls | FIXED: startup refuses the exact known placeholder values |
| P2-07 | P2 | DoS | api/agent/jobs GET (20×5MB) | unbounded aggregate poll response bytes | DOCUMENTED + mitigation guidance (agent batch size); protocol change deferred |
| P3-01 | P3 | Race | ws.ts trackAgentSocket close handler | late close of evicted socket can delete a replacement Set | FIXED: identity guard |
| P3-02 | P3 | Race | agent-lifecycle.ts transitionAgentLifecycle | read-then-write without row lock | NOT FIXED (documented; admin-console low concurrency) |
| P3-03 | P3 | UX | actions.ts deleteAgent | bare Error → sanitized generic message | FIXED: ActionError(…,409) |
| P3-04 | P3 | Correctness | canonicalize.ts localeCompare | locale-dependent fingerprint ordering | FIXED: codepoint compare (ASCII keys ⇒ same output; no fingerprint drift) |
| P3-05 | P3 | Consistency | test-print route literal 500 | duplicated limit | FIXED: import constant |
| P3-06 | P3 | Design | batch-status/apiKeyId filter + key rotation | in-flight jobs of replaced key → false UNKNOWN on sync | DOCUMENTED (operational note) |
| P3-07 | P3 | Docs | DOCS.md link, DEVELOPMENT.md Node≥22, API.md "every endpoint" | false/stale claims | FIXED |
| P3-08 | P3 | Deps | vitest4/TS5/eslint9/go1.26 language-ver/zeroconf unmaintained/caddy 2.11.3 | currency | Caddy→2.11.4 FIXED (patch); majors = NOT NOW (no gratuitous upgrades); zeroconf replacement = plan item |
| NOT-VERIFIED | — | verification | TS lint/typecheck/tests/build (no node_modules, installs forbidden, engine-strict Node≥24 vs local 22), npm/OSV advisories (network-blocked), Odoo suite (no Odoo runtime), Windows-only Go paths (compile-checked in CI only), Postgres migration apply (no psql/dockerd in sandbox) | honest gates |
