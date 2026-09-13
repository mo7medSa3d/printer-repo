# Target Architecture

## Model
The selected direction is **Pool + Bridge + Optional Silo**. Standard tenants share the application/runtime pool; deployment routing can later place an enterprise tenant on a dedicated stamp without changing application code.

## Boundaries
- Control plane: tenants, domains, identity, plans/entitlements, application/integration metadata, deployment mapping.
- Runtime/data plane: agents, printers, jobs, queues, heartbeats, WebSocket sessions, physical delivery.
- Odoo owns business truth. Gateway owns runtime hardware state. Agent owns local physical execution.

## Tenant resolution
`Host -> verified TenantDomain -> authenticated manager/session -> tenant-scoped repository query`. Hostname is never an authorization credential by itself.

## Database choice
Use shared PostgreSQL tables with mandatory `tenant_id`, composite ownership constraints, application authorization, and optional transaction-local RLS as a later defense-in-depth layer. RLS is deliberately not enabled by this patch because the current application does not consistently establish transaction-local tenant context on every worker/query path; enabling it prematurely would create an availability regression.

## Enterprise isolation
Introduce `deployment_id`/stamp mapping at the control-plane level before creating real dedicated infrastructure. This keeps pool/silo movement a deployment concern rather than a second codebase.

## SaaS control-plane implementation status (2026-09-13)

The implementation now contains first-class manager-session identity metadata (`user_id`, `role`), user-backed tenant membership authentication, a centralized manager permission policy, durable tenant-bound audit events with secret sanitization, subscription/plan tables with job-admission entitlement checks, and deployment-stamp/tenant-assignment persistence.

These are control-plane foundations, not a claim that billing, automated infrastructure provisioning, SSO, load certification, or enterprise silo operations are complete.
