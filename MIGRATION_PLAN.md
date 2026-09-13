# Migration Plan

## Applied in this patch
- `0029_enforce_tenant_id_not_null.sql` now performs a guarded legacy backfill before `NOT NULL`.
- `0030_tenant_domains_and_manager_sessions.sql` adds verified tenant domains and tenant-bound manager sessions.
- Existing manager sessions are deleted during migration because they are ephemeral authentication state and cannot be safely assigned a tenant after the fact.

## Multi-tenant onboarding
1. Create tenant.
2. Create verified `tenant_domains` entry.
3. Provision tenant-level Odoo API keys/Agent pairing under that tenant.
4. Start Agents and register printers.
5. Verify tenant-scoped negative tests before activating the tenant.

## Rollback principle
Do not delete runtime/business data during tenant migration. If legacy ownership is ambiguous, stop the migration and map ownership explicitly instead of fabricating it.
