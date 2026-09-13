# Current State Reconciliation

## Phase 1: Finalize Tenant Foundation
**Status:** COMPLETE
- `tenants`, `users`, `tenant_users`, `applications` added.
- `tenant_id` and composite constraints added to runtime tables.
- Database migration `0028` generated safely.

## Phase 2: Safe Legacy Migration
**Status:** MISSING
- Existing data lacks `tenant_id`. Backfill required.

## Phase 3: Identity + Authorization
**Status:** MISSING
- Need to update `src/server/auth.ts` or wherever Gateway auth lives to resolve tenant context.

## Phase 4: API Tenant Enforcement
**Status:** MISSING
- All `/api/*` routes need `tenant_id` scopes.

## Phase 5: Database Defense in Depth
**Status:** PARTIAL
- `withTenant` wrapper prototyped. Needs to wrap actual repository calls.

## Phase 6: Queue + Worker Isolation
**Status:** MISSING
- `claimAndPushJobToAgent` and related workers need tenant-awareness.

## Phase 7: WebSocket Isolation
**Status:** PARTIAL
- Design complete, but `src/server/ws.ts` needs implementation to filter by `tenant_id`.

## Phase 8: Cache / Storage / Audit Isolation
**Status:** MISSING
- Rate limiters / redis keys / logs need `tenant_id` prefix.

## Phase 9: Agent Identity + Pairing
**Status:** MISSING
- Pairing process needs `tenant_id` binding.

## Phase 10: Printer Inventory + Runtime State
**Status:** UNVERIFIED
- Needs verification that stale agents make printers unavailable but don't delete them.

## Phase 11: Manual Printer Registration
**Status:** MISSING
- Needs implementation to explicitly ACCEPT/REJECT manual registration.

## Phase 12: Odoo Printer Binding
**Status:** MISSING
- Branch/company isolation for printers in Odoo 19.

## Phase 13: Odoo POS
**Status:** MISSING
- `doesAnyOrderlineHaveTaxLabel is not a function` error in POS needs elimination.

## Phase 14: Report / PDF Routing
**Status:** MISSING
- Odoo PDF routing needs logic to fallback to native if gateway disabled.

## Phase 15: Gateway Test Print
**Status:** MISSING
- Fix React #441 for Gateway Test Print and ensure transport-aware printing.

## Phase 16: Local Agent Test Performance
**Status:** MISSING
- Investigate and fix 9-10s delay.

## Phase 17: Windows Printing
**Status:** UNVERIFIED
- Audit Windows Spooler implementation.

## Phase 18: Application / Integration Model
**Status:** MISSING
- Implement Odoo Integration model over API keys.

## Phase 19: Deployment Stamps
**Status:** PARTIAL
- Design complete (Routing protocol), needs implementation.

## Phase 20: Entitlements / Noisy Neighbors
**Status:** MISSING
- Plan/Subscription logic.

## Phase 21: Observability
**Status:** MISSING
- Tracing context.

## Phase 22: Security Attack Testing
**Status:** PARTIAL
- Negative tests stubbed, need implementation.

## Phase 23, 24, 25, 26, 27
**Status:** ONGOING/PENDING
