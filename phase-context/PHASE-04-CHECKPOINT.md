# Phase 04 - RBAC / Authorization

## Verification
- Investigated `src/lib/authorization.ts` and its usage across API routes and Server Actions.
- Verified that centralized permissions checks exist (e.g., `requireManagerPermission`) and are consistently applied across endpoints (e.g., `agents.pair`, `printers.manage`, `jobs.create`, `integrations.manage`).
- Verified that roles (`owner`, `admin`, `operator`, `viewer`, `integration_admin`, `billing_admin`) correctly map to granular permissions.

## Findings
- Authorization is centrally enforced server-side.
- Negative tests for admin privileges exist (verified previously in unit tests).
- RBAC lifecycle matches architectural requirements.
