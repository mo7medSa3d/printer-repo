# Tenant Isolation Model

1. Canonical tenant identity is `tenant_id`; not user, email, hostname, Odoo DB, company, or branch.
2. Manager sessions now carry `tenantId` and are checked against the persisted session row.
3. Manager tenant is resolved from a verified `tenant_domains` record; a single-tenant fallback or explicit `MANAGER_TENANT_ID` is allowed only as bootstrap configuration.
4. Odoo API keys already belong to a tenant; Odoo agent/printer/job paths now filter with that tenant identity.
5. Print-job creation requires tenant context and validates printer/agent ownership before insertion.
6. Composite foreign keys keep `job.tenant_id` consistent with its agent and printer.
7. Legacy migration backfills only when exactly zero/one tenant is known; it raises on ambiguous multi-tenant legacy ownership.
8. Cross-tenant identifiers therefore fail closed as `not found`/authorization failures instead of returning another tenant's record.
