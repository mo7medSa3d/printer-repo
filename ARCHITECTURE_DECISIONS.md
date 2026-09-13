# Architecture Decisions

## ADR-001: Pool + Bridge + Optional Silo
**Decision:** Shared pool by default; deployment mapping allows a future dedicated stamp.
**Rejected:** one full stack per customer by default (high cost/operational burden) and permanently shared-only (insufficient enterprise isolation).

## ADR-002: Shared PostgreSQL tables with tenant_id
**Decision:** mandatory tenant columns + composite ownership FKs + application authorization.
**Rejected:** database-per-tenant as default because backup, migrations, and fleet operations become unnecessarily expensive at higher tenant counts.

## ADR-003: Host maps to tenant, but does not authorize
**Decision:** verified domain resolves tenant context, then authenticated identity authorizes resource access.
**Rejected:** trusting hostname alone.

## ADR-004: No premature RLS enforcement
**Decision:** keep RLS as defense-in-depth option; do not enable it until every query/worker path reliably establishes a transaction-local tenant context.

## ADR-005: Preserve durable print fencing
**Decision:** retain `SKIP LOCKED`, claim tokens, stale-claim handling, and local execution ledger.
**Rejected:** replacing the durable queue with a broker without evidence that PostgreSQL is the bottleneck.

## Research basis
The architecture choice was checked against current authoritative guidance:
- AWS SaaS Lens: pool/bridge/silo tenant isolation and noisy-neighbor controls.
- Azure Architecture Center: multitenancy and Deployment Stamps.
- PostgreSQL 17: Row-Level Security policies and default-deny behavior.
- Odoo 19: access rights and record rules; Odoo remains an integration boundary rather than the SaaS tenant authority.
- Microsoft Windows printing architecture: Print Spooler and printer-driver responsibilities.
- Next.js 16: expected operational errors should be represented as structured results/states instead of uncaught exceptions.

RLS is therefore retained as defense-in-depth but intentionally not enabled by this patch until transaction-local tenant context is consistently established for every application and worker query path.
