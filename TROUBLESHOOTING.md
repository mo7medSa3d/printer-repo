# Troubleshooting

### Manager login says tenant is not configured
Verify the request `Host` matches a `tenant_domains.domain` row with `verified_at` set, or set `MANAGER_TENANT_ID` for a single-tenant deployment.

### Printer ID returns Not Found
This is expected when the printer belongs to another tenant; do not bypass the tenant predicate.

### Migration 0029 aborts
The database contains unowned rows while multiple tenants exist. Stop and map the legacy rows explicitly; do not force a default tenant.

### Agent online state changes
Heartbeat freshness controls runtime availability. Configuration is retained when an Agent becomes stale/offline.
