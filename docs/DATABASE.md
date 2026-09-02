# Database schema and migrations

PostgreSQL, accessed through Drizzle ORM. Schema definition: `src/db/schema.ts`.
Migrations: plain SQL files in `drizzle/`, tracked in `drizzle/meta/_journal.json`.

The column lists below were dumped from a database built by applying
`drizzle/0000 → 0005` in order, and cross-checked against `src/db/schema.ts`.

## Migrations

| File | Contents |
|---|---|
| `0000_simple_tigra.sql` | Base schema: branches, destinations, local_networks, printer_bindings, agents, printers, api_keys, manager_sessions, print_jobs |
| `0001_phase1_branch_foundation.sql` | Branch foundation: `branch_id` columns, foreign keys and routing indexes |
| `0002_add_document_types.sql` | `document_types` table + FK/index (guarded with `IF NOT EXISTS` / `pg_constraint` checks) |
| `0003_add_idempotency_key.sql` | `print_jobs.idempotency_key` + partial unique index on `(branch_id, idempotency_key)` |
| `0004_add_job_delivery_tracking.sql` | `print_jobs.delivery_attempts`, `delivered_at`, `acked_at` + `print_jobs_claimed_at_idx` (all `IF NOT EXISTS`) |
| `0005_auth_rate_limits.sql` | `auth_rate_limits` table for shared manager-login rate limiting |

Applying them in filename order to an empty database produces exactly the schema in
`schema.ts`. Migrations 0002–0004 are idempotent; 0000/0001 are not (they will raise
`duplicate table` if replayed on a populated database — the test harness tolerates that
explicitly).

Apply them with any SQL client, or use Drizzle:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run db:push      # push schema.ts (dev)
DATABASE_URL=…                                  npm run db:generate # generate a new migration
DATABASE_URL=…                                  npm run db:studio   # inspect
```

For a production deployment, applying the SQL files in order is the reproducible path.

## Tables

### `branches` — one physical location (owned by Odoo)
`id` PK · `company_id` · `name` NOT NULL · `description` · `location` · `timezone` ·
`enabled` NOT NULL default true · `gateway_url` · `metadata` jsonb · `created_at` ·
`updated_at`
Indexes: `branches_name_idx`, `branches_enabled_idx`

### `destinations` — where something prints inside a branch (owned by Odoo)
`id` PK · `branch_id` → branches NOT NULL · `name` NOT NULL · `type` NOT NULL ·
`description` · `zone` · `enabled` · `metadata` · timestamps
Indexes: branch, type, enabled

### `document_types` — logical document classes (owned by Odoo)
`id` PK · `branch_id` → branches NOT NULL · `name` NOT NULL · `description` ·
`payload_hint` · `enabled` · timestamps
Indexes: branch, name

### `local_networks` — optional network grouping inside a branch
`id` PK · `branch_id` NOT NULL · `name` NOT NULL · `description` · `enabled` ·
`metadata` · `created_at`

### `agents` — one per Windows PC (owned by the gateway)
`id` PK · `name` NOT NULL · `pairing_code` · `pairing_code_expires_at` ·
`secret` (SHA-256 hash) · `status` NOT NULL default `offline` · `metadata` ·
`last_seen_at` · `branch_id` NOT NULL · `local_network_id` · timestamps
Indexes: branch, local network, `agents_last_seen_idx`

### `printers` — runtime printer registration (owned by the gateway/agent)
`id` PK · `agent_id` → agents NOT NULL · `branch_id` NOT NULL · `name` NOT NULL ·
`type` NOT NULL · `printer_type` default `thermal` · `connection_type` default `tcp` ·
`protocol` default `escpos` · `status` default `unknown` · `config` jsonb ·
`capabilities` jsonb · `enabled` · `last_seen_at` · timestamps
Indexes: agent, branch, status, printer type

`capabilities.supported_protocols` is the list the routing capability check uses; the agent
reports it in the heartbeat unless the operator pinned it in the agent config.

### `printer_bindings` — routing rules (owned by Odoo)
`id` PK · `branch_id` NOT NULL · `destination_id` NOT NULL · `document_type` (null = wildcard) ·
`printer_id` NOT NULL · `priority` NOT NULL default 1 · `enabled` NOT NULL default true ·
`enabled_at` · `disabled_at` · `config_override` jsonb · timestamps
Indexes: `printer_bindings_routing_idx (branch_id, destination_id, document_type, priority)`,
printer, enabled

### `api_keys` — Odoo API keys
`id` PK · `branch_id` (null = global) · `scope` default `standard` (`read_only` blocks
writes) · `name` NOT NULL · `description` · `hashed_key` UNIQUE NOT NULL ·
`allowed_document_types` jsonb (string array, compared case-insensitively) ·
`created_at` · `last_used_at` · `revoked_at`

### `manager_sessions` — dashboard sessions
`jti` PK · `created_at` · `expires_at` NOT NULL · `revoked_at`
Index: `manager_sessions_expires_idx`

### `auth_rate_limits` — manager login throttling (shared across gateway instances)
`key` PK (`ip:<addr>` or `acct:<username>`) · `failures` · `window_started_at` ·
`locked_until` · `updated_at`
Index: `auth_rate_limits_locked_until_idx`

### `print_jobs` — the durable job queue
| Column | Notes |
|---|---|
| `id` PK | `job_<nanoid(12)>`; never regenerated for a retry |
| `branch_id` NOT NULL, `destination_id`, `document_type` | routing context |
| `agent_id` NOT NULL, `printer_id` NOT NULL | resolved target |
| `status` NOT NULL default `queued` | `queued\|claimed\|printing\|success\|failed\|expired` |
| `payload` jsonb NOT NULL | `{type,encoding,data}` |
| `error` | failure reason (≤ 2000 chars) |
| `requested_by` | `odoo`, `odoo-legacy`, manager action |
| `idempotency_key` | deduplication key from Odoo |
| `retries` NOT NULL default 0 | incremented by stale-claim reclaim; ≥ 5 ⇒ permanent failure |
| `claimed_at` | when the gateway took ownership; lease = `claimed_at + 90 s` |
| `delivery_attempts` NOT NULL default 0 | claim/hand-over attempts; ≥ 5 undelivered ⇒ failed |
| `delivered_at` | the job actually left the gateway |
| `acked_at` | agent confirmed receipt (`job_ack`), never implies printing |
| `expires_at` NOT NULL | business TTL; independent of the claim lease |
| `created_at`, `updated_at` | `updated_at` doubles as the staleness clock |

Indexes: `print_jobs_branch_id_idx`, `print_jobs_agent_status_idx`,
`print_jobs_printer_status_idx`, `print_jobs_status_expires_idx`,
`print_jobs_destination_id_idx`, `print_jobs_claimed_at_idx (status, claimed_at)`,
`print_jobs_branch_idempotency_idx`, and the partial unique index
`print_jobs_branch_idempotency_unique (branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

## Concurrency

The claim path relies on PostgreSQL semantics that cannot be emulated:
`SELECT … FOR UPDATE SKIP LOCKED` inside a transaction plus a conditional `UPDATE`
(`src/lib/job-delivery.ts` for a single job, `src/app/api/agent/jobs/route.ts` for the poll
batch). This is why the database-backed test suites require a real PostgreSQL instance —
see [TESTING.md](TESTING.md).

## Test database

```bash
createdb printgw_test
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
```

`tests/helpers/pg.ts` applies every `drizzle/*.sql` file itself (tolerating
"already exists" on a re-run), verifies the delivery-tracking columns are present, and
truncates all tables between tests.
