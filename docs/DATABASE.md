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
| `0006_printer_branch_via_agent.sql` | Drops `printers.branch_id`. Refuses to apply (raises) if any printer disagrees with its agent's branch, has no agent, or has an agent without a branch — the error names the printer, both branches and the agent. Idempotent: a no-op once the column is gone. |
| `0007_lifecycle_and_ratelimit_retention.sql` | Retention index on `auth_rate_limits(updated_at)`, deterministic routing index `printer_bindings(branch_id, destination_id, document_type, priority, id)`, `printers(agent_id)`, `agents(status)`; makes `agents.secret` nullable so retiring an agent can revoke its credential. Fully idempotent. |

Applying them in filename order to an empty database produces exactly the schema in
`schema.ts`. Migrations 0002–0004, 0006 and 0007 are idempotent; 0000/0001 are not (they will raise
`duplicate table` if replayed on a populated database — the test harness tolerates that
explicitly, and additionally applies each file exactly once via a `__test_migrations`
ledger so that replaying 0001 cannot re-create the column 0006 removes).

Migration history is append-only: 0006 removes `printers.branch_id` as a **new**
migration rather than by editing 0000/0001, so existing deployments upgrade forward
along the same path that produced their current schema.

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
**A printer has no branch column.** Its branch is `printer -> agent -> agents.branch_id`.
The agent is the single owner of branch context; see "Printer branch derivation" below.

`id` PK · `agent_id` → agents NOT NULL · `name` NOT NULL ·
`type` NOT NULL · `printer_type` default `thermal` · `connection_type` default `tcp` ·
`protocol` default `escpos` · `status` default `unknown` · `config` jsonb ·
`capabilities` jsonb · `enabled` · `last_seen_at` · timestamps
Indexes: agent, status, printer type

#### Printer branch derivation

There is exactly one path from a printer to a branch:

```
branches <- agents.branch_id <- printers.agent_id
```

* `printers.agent_id` is `NOT NULL` and FK-constrained, so every printer resolves
  to exactly one branch. There is no orphan/unassigned state to fall back from.
* Application code must never invent a branch for a printer. There is no
  `printer.branch_id ?? "default"` anywhere; a printer whose branch cannot be
  resolved is a hard error, not a printer in the default branch.
* Helpers live in `src/lib/printer-branch.ts`
  (`branchIdOfPrinter`, `loadPrinterWithBranch`, `branchIdsForPrinters`,
  `listPrintersInBranch`, `assertPrinterInBranch`). SQL joins `printers` to
  `agents` rather than reading a denormalised column.
* **Moving a printer between branches is done by moving its agent** (or by
  reassigning the printer to an agent in the target branch). Because the branch
  is derived, every printer on an agent moves atomically with it and the two can
  never disagree.
* `printer_bindings.branch_id` and `print_jobs.branch_id` are retained
  deliberately (routing scope and historical record respectively) and are
  validated against the derived branch at write time — they are not a second
  source of truth. A job keeps the branch it was printed for even if the agent
  is moved afterwards.

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

#### Retention

`auth_rate_limits` gains a row for every distinct source IP and every attempted
username, so it grows with attack traffic. A bucket only matters while it can
still change a decision — while its 15-minute failure window is open, or while
`locked_until` is in the future. Anything older than both (plus a 1-hour grace)
is deleted by `cleanupAuthRateLimits()`:

* **bounded** — at most `CLEANUP_BATCH` (1000) rows per pass, so it can never
  hold a long lock on the authentication path;
* **opportunistic** — runs on ~1% of successful logins, and is also exported for
  a scheduled maintenance job;
* **non-blocking** — failures are swallowed; a maintenance problem must never
  become an authentication outage;
* **never deletes an active lock**, even a stale one, which would hand an
  attacker an instant reset.

Supported by `auth_rate_limits_updated_at_idx`.

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
