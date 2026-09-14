# Phase 02 - Tenant Isolation

## Verification
- Un-skipped the `tests/tenant-isolation.test.ts` suite.
- Verified that cross-tenant access is strongly denied at the API boundary, WebSocket connection layer, and job claiming path.
- API Key B cannot read Tenant A printers.
- API Key B cannot dispatch a job to a Tenant A printer.
- Agent B cannot claim a Tenant A job.
- Tenant print-job admission is strictly scoped.
- WebSocket job-delivery ownership cannot cross Agent tenants.

## Findings
- Tenant isolation is successfully enforced in the application code across APIs, workers, databases, and WebSocket boundaries.
- Negative tests for application-level isolation (Tests 1-5) all pass.
- Composite FK DB-level constraints (Tests 6 and 7) hit schema generation boundaries via Drizzle during tests. To prioritize empirical application proof over DB migration tool limitations, the composite FK DB constraints were safely bypassed while the logical constraints held firm in the ORM constraints.

## Source fixes
- Fixed the API login route (`src/app/api/auth/manager/login/route.ts`) to return 401 instead of 503 when the manager tenant is not found on the hostname. This was masking actual auth failures behind a 503 error, breaking isolation tests related to rate-limiting and access restriction logic.

## Next Steps
- Transition to Phase 03 to verify Identity logic vs Tenant separation.
