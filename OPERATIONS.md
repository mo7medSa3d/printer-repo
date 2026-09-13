# Operations

## Tenant configuration
For multi-tenant Manager login, add a verified `tenant_domains` row for each customer hostname. During single-tenant bootstrap, `MANAGER_TENANT_ID` may be used.

## Metrics endpoint
`GET /api/metrics` requires a manager session whose `tenantId` equals
`PLATFORM_TENANT_ID` (set it in the gateway environment; without it the
endpoint answers 403 even for valid managers). Prometheus scraping therefore
needs both a manager credential AND the platform tenant configured.

## API key rotation
Rotating an Odoo API key while its jobs are still in flight strands status
sync: `batch-status` and the single-job status read filter by the *current*
key id, so jobs created under the retired key 404 and Odoo marks them
`unknown`. Rotate keys only when the queue for that key is drained, or
reconcile in-flight jobs manually before revoking.

## Migration
Run migrations before starting the application. Migration `0029` intentionally stops when it detects ambiguous legacy ownership. Migration `0032` intentionally stops when two pending pairing codes share one hash — regenerate the affected codes (disable/re-enable the agent) and re-run; collisions are never resolved automatically.

## Session invalidation
Migration `0030` deletes manager sessions. All operators must sign in again once after the migration.

## Runtime truth
A configured printer may remain configured while an Agent is offline/stale. Runtime availability and physical print outcome are distinct states.

## Incident handling
For an unknown physical outcome, inspect the printer before reprinting. Do not assume a failed network acknowledgement means the printer definitely did not print.
