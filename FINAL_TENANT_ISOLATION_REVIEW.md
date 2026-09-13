# Final Tenant Isolation Review

## Ownership map reviewed

| Resource | Tenant ownership | Evidence status |
|---|---|---|
| tenants | root | STATIC-VERIFIED |
| users | global identity | STATIC-VERIFIED |
| tenant_users | tenant membership | STATIC-VERIFIED |
| manager_sessions | tenant + user + role | STATIC-VERIFIED |
| agents | tenant | STATIC-VERIFIED |
| printers | tenant + agent | STATIC-VERIFIED |
| print_jobs | tenant + agent + printer | STATIC-VERIFIED |
| api_keys | tenant/integration | STATIC-VERIFIED |
| discovery_sessions | tenant + agent | STATIC-VERIFIED |
| discovered_devices | tenant + agent | STATIC-VERIFIED |
| audit_events | tenant | STATIC-VERIFIED |
| plans/subscriptions | tenant subscription | STATIC-VERIFIED |
| deployment assignments | tenant + stamp | STATIC-VERIFIED |

## Controls observed

1. Manager sessions carry `tenantId`, `userId`, and `role`.
2. Manager sessions are revalidated against `tenant_users` membership and role.
3. Important resource lookups use tenant predicates.
4. Manager actions enforce centralized permissions before mutation.
5. Job insertion requires a non-empty tenant context and performs tenant-scoped printer/agent validation.
6. Race-sensitive quota admission uses tenant-specific PostgreSQL advisory transaction locking.
7. Discovery and agent/provisioning paths were updated to enforce authorization and tenant ownership.

## Negative-test cases required for final certification

- Tenant A reads/updates/deletes Tenant B agent.
- Tenant A reads/updates/deletes Tenant B printer.
- Tenant A reads/retries/cancels Tenant B job.
- Tenant A rotates/revokes Tenant B integration key.
- Tenant A provisions Tenant B discovered device.
- Tenant A manipulates object IDs inside JSON payloads.
- Tenant A attempts to reuse Tenant B Agent credential.
- Tenant A uses Tenant B Odoo credential.
- Tenant A uses a forged host to select Tenant B.

These are designed but not all dynamically executed because the full DB/server stack was unavailable.

## Odoo isolation

Odoo code uses `sudo()` in several controlled flows. Current Odoo 19 documentation warns that superuser access bypasses record rules/access rights and therefore requires extreme caution. citeturn639871search0turn639871search2

Static inspection shows company/tenant validations around the main Gateway routing path, but the Odoo 19 runtime was not available, so cross-company negative browser tests are still **NOT VERIFIED**.

## Verdict
`TENANT BOUNDARY LOOKS STRUCTURALLY SOUND — DYNAMIC PROOF INCOMPLETE`
