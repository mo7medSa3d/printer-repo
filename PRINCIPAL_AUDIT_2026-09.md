# Principal Code Audit — September 2026

Scope: Gateway, PostgreSQL/Drizzle, WebSocket delivery, Windows Go Agent, Odoo addon, test topology, and CI/tooling contracts.

## Critical findings fixed in this audit branch

| Severity | Area | Root cause | Fix |
|---|---|---|---|
| P1 | Job lifecycle | Agent could explicitly request `expired` through the generic PATCH state machine before the business TTL elapsed. | `expired` is now server-controlled; agent transitions only cover `claimed -> printing/failed` and `printing -> success/failed`. |
| P1 | Routing | Resolver could route while a branch or destination was disabled. | Resolver rejects disabled branch/destination before candidate evaluation. |
| P1 | Routing isolation | A corrupt cross-branch binding could abort resolution immediately instead of allowing a safe fallback. | Cross-branch candidates are skipped; a valid same-branch fallback can still win. |
| P1 | Printer availability | `unknown` telemetry could be treated as available. | Immediate routing now requires positive `online` telemetry and active lifecycle. |
| P1 | Server actions | Manager-created jobs bypassed the branch-enabled gate. | Printer owner agent and branch are resolved and the branch must be enabled. Activation of agents/printers also checks branch state. |
| P1 | Database integrity | Runtime statuses/counters/priority relied on application validation only. | Added PostgreSQL CHECK constraints and matching Drizzle schema declarations. |
| P1 | Odoo synchronization | A stale remote status read could regress an already-terminal local result. | Normalize remote status and reject invalid/regressive updates. |
| P1 | Odoo routing mapping | Equal-priority mappings did not have an explicit deterministic tie-breaker. | Explicit `priority asc, id asc` search order. |
| P1 | Heartbeat contract | Invalid agent status silently became `online`. | Invalid status now returns HTTP 400; casing/whitespace is normalized. |
| P1 | Binding API | Priority accepted negative/fractional/non-finite values. | Validate safe integer priority in `0..1,000,000`. |
| P1 | Manager auth | JWT header/claims were only partially validated; plaintext manager password was accepted in production. | Enforce HS256/JWT type, bounded claims, future-`iat` rejection, and production ban on plaintext password. |

## Test coverage added/updated

- Job state-machine regression for agent-controlled expiration.
- Heartbeat invalid status and normalization coverage.
- Routing coverage for disabled branches/destinations/printers, offline/unknown telemetry, deterministic fallback, cross-branch corruption, and document-type authorization.
- Database constraint tests for runtime statuses, negative retry counters, delivery attempts, and binding priority.
- Manager authentication tests for DB-backed sessions, JWT header validation, future `iat`, scrypt passwords, and production plaintext rejection.

## Delivery guarantees

The existing architecture remains at-least-once for physical printing. WebSocket delivery uses claim-before-send, explicit acknowledgement, local agent deduplication, and stale-claim recovery. Physical devices themselves do not provide exactly-once semantics for arbitrary RAW/IPP/Windows spooler transports.

## Remaining environment-dependent validation

The repository's CI verifies Node/PostgreSQL integration, Go tests/race, and Windows installer build/install smoke tests. Live Odoo integration and physical-printer E2E still require the corresponding external environment and hardware and therefore are not claimed as CI-proven here.

## Release gate

Do not merge the audit branch until the full GitHub CI and Windows installer workflow are green on the final branch head.
