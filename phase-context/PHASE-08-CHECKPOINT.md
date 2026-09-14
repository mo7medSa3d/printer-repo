# Phase 08 - Queue / Idempotency / Claim Fencing

## Verification
- Investigated `src/lib/job-delivery.ts` and `src/lib/job-maintenance.ts`.
- Inspected the Postgres database claim mechanism (`FOR UPDATE SKIP LOCKED`).
- Validated that the claim process prevents duplicate concurrent claims using `pg_advisory_xact_lock` coupled with Postgres-level atomic UPDATE locks.
- Tested fencing (stale claim checks): the `claim_token` tracks the exact worker instance claim, which is required for terminal updates.
- Verified that all idempotency boundaries are robust: the combination of `(tenant_id, api_key_id, idempotency_key)` maintains durability safely and prevents duplicate submissions while properly responding to explicit retries and TTL expiration.

## Findings
- Job states correctly model `queued`, `claimed`, `delivered`, `acked`, `failed`, `unknown`.
- Duplicate submissions map identically and correctly, and concurrent requests correctly fall back gracefully without duplicate executions.
- Verified through integration suites `print-idempotency.test.ts`, `ws-claim-delivery.test.ts`, and `job-status-postgres-concurrency.test.ts`.

## Actionable
- Fully passes constraints in current form; no structural defect to fix.
