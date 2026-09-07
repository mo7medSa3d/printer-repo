# Database schema and migrations

PostgreSQL, accessed through Drizzle ORM. Schema definition: `src/db/schema.ts`.
Migrations: plain SQL files in `drizzle/`, tracked in `drizzle/meta/_journal.json`.

The schema below is the final runtime-only shape produced by applying
`drizzle/0000 → 0021` in order, and matches `src/db/schema.ts`.

> **Ownership:** the Gateway database stores runtime infrastructure only — agents, runtime
> printers, discovery sessions/devices, the job queue, rate-limit and session state, API keys and
> metrics. Odoo business entities (companies, branches, destinations, document-type catalogs,
> print bindings) are **not** stored here; they were removed by migration `0020`. The `destination`
> and `document_type` columns on `print_jobs` are informational labels supplied by the Odoo
> integration boundary, not Gateway-owned business records.

## Migrations

| File | Contents |
|---|---|
| `0000_simple_tigra.sql` | Base schema (historical; business tables removed later by `0020`) |
| `0001_phase1_branch_foundation.sql` | (historical) branch foundation |
| `0002_add_document_types.sql` | (historical) document-type catalog |
| `0003_add_idempotency_key.sql` | (historical) idempotency key + branch-scoped unique index |
| `0004_add_job_delivery_tracking.sql` | `delivery_attempts`, `delivered_at`, `acked_at` + claim index |
| `0005_auth_rate_limits.sql` | `auth_rate_limits` (shared manager-login rate limiter) |
| `0006_architecture_hardening.sql` | lifecycle/type/protocol constraints + FK hardening |
| `0007_auth_rate_limit_retention.sql` | 24 h retention for auth rate-limit state |
| `0008_remove_pcl_contract.sql` | guards before lifecycle CHECK additions |
| `0009_runtime_invariant_guard.sql` | runtime invariant guards |
| `0010_discovery.sql` | `discovery_sessions` + `discovered_devices` with TTLs |
| `0011_worker_schema_fk_hardening.sql` | FK hardening for isolated worker schemas |
| `0012_runtime_state_checks.sql` | DB-enforced state-machine CHECK constraints |
| `0013_runtime_state_constraint_scope_fix.sql` | repair `0012` for isolated schemas (`current_schema()`) |
| `0014_discovery_state_checks.sql` | discovery trust-state CHECK constraints |
| `0015_metrics_and_agent_notifications.sql` | `gateway_metrics` + `notify_agent_job_available` trigger |
| `0016_print_job_rate_limits.sql` | per-key `print_job_rate_limits` (60/min, 1000/hr) |
| `0017_notify_requeued_jobs.sql` | `pg_notify` on requeue |
| `0018_global_print_job_idempotency.sql` | global idempotency index (superseded by `0021`) |
| `0019_drop_legacy_print_destination_fk.sql` | drops the legacy destination FK |
| `0020_remove_gateway_business_ownership.sql` | removes branches/destinations/document_types/local_networks/printer_bindings and all `branch_id`/`local_network_id` columns |
| `0021_scope_print_jobs_to_api_key.sql` | adds `print_jobs.api_key_id`, re-scopes idempotency to `(api_key_id, idempotency_key)` |

Applying them in filename order to an empty database produces exactly the schema in `schema.ts`.

Apply them with any SQL client, or use Drizzle:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run db:migrate  # applies the journal (drizzle-orm migrate)
DATABASE_URL=…                                  npm run db:push      # push schema.ts (dev)
DATABASE_URL=…                                  npm run db:generate # generate a new migration
DATABASE_URL=…                                  npm run db:studio   # inspect
```

For a production deployment, `npm run db:migrate` (which follows `drizzle/meta/_journal.json`) is
the reproducible path. **Every migration present in `drizzle/*.sql` must also be present in the
journal** — `migrate()` only applies entries listed there.

## Tables

### `agents` — one per Windows PC (owned by the Gateway)
`id` PK · `name` NOT NULL · `pairing_code` · `pairing_code_expires_at` · `secret` (SHA-256 hash) ·
`status` NOT NULL default `offline` (`online|offline`) · `lifecycle` NOT NULL default `active`
(`active|disabled|retired`) · `metadata` jsonb · `last_seen_at` · `created_at` · `updated_at`

Index: `agents_last_seen_idx` · Checks: `agents_lifecycle_check`, `agents_status_check`

### `printers` — runtime printer registration (owned by the Gateway/Agent)
`id` PK · `agent_id` → agents NOT NULL · `name` NOT NULL · `printer_type` default `physical`
(`physical|virtual|redirected`) · `device_class` default `unknown` (`thermal|laser|inkjet|label|other|unknown`) ·
`connection_type` default `network` (`network|usb|spooler|ipp|ipps`) · `protocol` default `raw`
(`raw|escpos|ipp|ipps|spooler`) · `status` default `unknown` (`online|offline|busy|error|unknown`) ·
`lifecycle` default `active` (`active|disabled|retired`) · `config` jsonb · `capabilities` jsonb ·
`last_seen_at` · `created_at` · `updated_at`

Indexes: `printers_agent_id_idx`, `printers_printer_type_idx`, `printers_status_idx` ·
Checks: lifecycle, type, device class, connection type, protocol, status

`capabilities.supported_protocols` is the list the routing capability check uses; the agent
reports it in the heartbeat unless the operator pinned it in the agent config.

### `api_keys` — Odoo installation API keys
`id` PK · `scope` default `standard` · `name` NOT NULL · `description` ·
`hashed_key` UNIQUE NOT NULL (SHA-256 of the raw `odoo_…` key) · `allowed_document_types` jsonb ·
`created_at` · `last_used_at` · `revoked_at`

> `scope` and `allowed_document_types` are **retained legacy columns**: no current key-creation
> path populates them, and the Odoo authorization model is installation-scoped (one key per Odoo
> database). The enforcement helper (`src/lib/odoo-auth.ts`) treats an unset scope/document list as
> permissive. Do not advertise document-type-scoped credentials until a creation path actually
> sets these columns.

### `manager_sessions` — dashboard sessions
`jti` PK · `created_at` · `expires_at` NOT NULL · `revoked_at` · Index: `manager_sessions_expires_idx`

### `auth_rate_limits` — manager login throttling (shared across Gateway instances)
`key` PK (`ip:<addr>` or `acct:<username>`) · `failures` · `window_started_at` · `locked_until` · `updated_at`
Indexes: `auth_rate_limits_locked_until_idx`, `auth_rate_limits_updated_at_idx`

### `discovery_sessions` — one discovery run
`id` PK · `agent_id` → agents NOT NULL · `status` default `running` · `config` jsonb · `stats` jsonb ·
`started_at` · `completed_at` · `created_at` · `updated_at` ·
Indexes: `discovery_sessions_agent_id_idx`, `discovery_sessions_status_idx`

### `discovered_devices` — discovery observations (trust-scoped by agent)
`id` PK · `discovery_id` → discovery_sessions NOT NULL · `agent_id` → agents NOT NULL ·
`source` text[] · `protocol` · `ip_address` · `hostname` · `port` · `mac_address` · `device_name` ·
`manufacturer` · `model` · `serial_number` · `firmware_version` · `printer_state` · `uri` · `transport` ·
`confidence` default `low` (`low|medium|high`) · `verification` default `candidate` (`candidate|verified`) ·
`device_class` · `capabilities` jsonb · `raw_metadata` jsonb · `provisioned_printer_id` → printers ·
`candidate_status` default `discovered` (`discovered|verified|provisioned|ignored|expired`) ·
`discovered_at` · `last_seen_at` · `created_at` · `updated_at`

Indexes: `discovered_devices_discovery_id_idx`, `discovered_devices_agent_id_idx`,
`discovered_devices_candidate_status_idx`, `discovered_devices_confidence_idx` ·
Checks: `discovered_devices_confidence_check`, `discovered_devices_verification_check`,
`discovered_devices_candidate_status_check`

### `print_jobs` — the durable job queue
| Column | Notes |
|---|---|
| `id` PK | `job_<nanoid(12)>`; never regenerated for a retry |
| `api_key_id` → api_keys (nullable) | installation scope; null only for Manager-created jobs not exposed via the Odoo status API |
| `destination`, `document_type` | informational labels from the Odoo integration boundary |
| `agent_id` NOT NULL, `printer_id` NOT NULL | resolved runtime target |
| `status` NOT NULL default `queued` | `queued|claimed|printing|success|failed|expired` |
| `payload` jsonb NOT NULL | `{type,encoding,data}` |
| `error` | failure reason, including physical-outcome markers (`…physical output is unknown…`) |
| `requested_by` | `odoo` or manager action |
| `idempotency_key` | deduplication key from Odoo |
| `retries` NOT NULL default 0 | incremented by stale-claim reclaim; ≥ 5 ⇒ permanent failure |
| `claimed_at` | when the Gateway took ownership; lease = `claimed_at + 90 s` |
| `delivery_attempts` NOT NULL default 0 | claim/hand-over attempts; ≥ 5 undelivered ⇒ failed |
| `delivered_at` | the job actually left the Gateway |
| `acked_at` | agent confirmed receipt (`job_ack`), never implies printing |
| `expires_at` NOT NULL | business TTL; independent of the claim lease |
| `created_at`, `updated_at` | `updated_at` doubles as the staleness clock |

Indexes: `print_jobs_agent_status_idx`, `print_jobs_printer_status_idx`,
`print_jobs_status_expires_idx`, `print_jobs_claimed_at_idx (status, claimed_at)`,
`print_jobs_api_key_id_idx`, and the partial unique index
`print_jobs_idempotency_unique (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND api_key_id IS NOT NULL`.

Checks: `print_jobs_status_check`, `print_jobs_retries_check`, `print_jobs_delivery_attempts_check`.

### `print_job_rate_limits` — per-installation print-job throttling
`api_key_id` PK → api_keys ON DELETE CASCADE · `minute_window_started_at` · `minute_count` ·
`hour_window_started_at` · `hour_count` · `updated_at` ·
Index: `print_job_rate_limits_updated_idx` · Checks: minute/hour counts ≥ 0

### `gateway_metrics` — operational Prometheus counters
`name` PK · `value` bigint NOT NULL default 0 (`CHECK value >= 0`) · `updated_at` timestamptz

> This table is created by migration `0015` and is written exclusively through raw SQL in
> `src/lib/metrics.ts` (`INSERT … ON CONFLICT DO UPDATE`) so that metrics can never break a print,
> auth, or job request. It is still declared in `src/db/schema.ts` so the schema file remains the
> complete source of truth for every table.

## Concurrency

The claim path relies on PostgreSQL semantics that cannot be emulated:

* `SELECT … FOR UPDATE OF p, a, pr SKIP LOCKED` inside a transaction plus a conditional
  `UPDATE … WHERE status='queued'` (`src/lib/job-delivery.ts` for a single job,
  `src/app/api/agent/jobs/route.ts` for the poll batch). The owner rows are locked at the claim
  decision point, so a lifecycle change serializes with the claim and two Gateway instances can
  never hand the same job to two agents.
* Per-agent and per-key enqueue are serialized with
  `pg_advisory_xact_lock(hashtext('print_jobs:agent:<id>'))` / `pg_advisory_xact_lock(hashtext('print_jobs:key:<id>'))`
  (`src/lib/print-job-service.ts`), closing the idempotency and queue-cap race windows.
* `LISTEN/NOTIFY` (`notify_agent_job_available`) is a wake-up hint only; polling and transactional
  claims are the recovery path when a notification is lost or a Gateway replica restarts.

This is why the database-backed test suites require a real PostgreSQL instance — see
[TESTING.md](TESTING.md).

## Test database

```bash
createdb printgw_test
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
```

`tests/helpers/pg.ts` applies every `drizzle/*.sql` file itself (tolerating "already exists" on a
re-run), verifies the delivery-tracking columns and installation-scoped idempotency index are
present, and truncates all tables between tests.
