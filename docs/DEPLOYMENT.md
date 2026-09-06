# Deployment

## 1. Gateway

### Requirements

* Node ≥ 24.20 (`.nvmrc` / `.node-version` and `engine-strict=true` enforce the supported runtime), PostgreSQL 14+.
* One process serves both HTTP and the agent WebSocket (`server.ts`). In the reference production
  deployment the gateway listens privately on port `3000`; Caddy is the only public entry point.
* Production traffic is HTTPS at Caddy on ports 80/443. Do not expose gateway port 3000 publicly.
* **Tenancy model: one Odoo database per Gateway installation.** This repository does not support
  multiple independent Odoo databases sharing one Gateway PostgreSQL instance. Production startup
  requires `ODOO_DATABASE_NAME`, and every Odoo→Gateway request carries `X-Odoo-Database` with the
  exact database name. Two Odoo databases may both contain `company_id = 1`; that is safe because
  the database identity is a separate mandatory authorization boundary.

### Steps

```bash
npm ci
npm run db:migrate
npm run build
NODE_ENV=production npm start
```

Environment: `DATABASE_URL`, `ODOO_DATABASE_NAME`, `GATEWAY_JWT_SECRET` (≥ 32 chars), `MANAGER_USERNAME`,
`MANAGER_PASSWORD_HASH` (preferred), `GATEWAY_DOMAIN`, optional `PORT`/`HOSTNAME`.
Full list: [CONFIGURATION.md](CONFIGURATION.md).

### Timezone requirement (mandatory UTC)

The schema stores all time columns as `timestamp` **without** time zone, and
the gateway's correctness depends on the application and the database
agreeing on "now": the 90-second stale-claim lease, the stale-`printing`
sweep, `expires_at` TTLs and keep-alive leases all compare SQL `now()` with
timestamps written by the Node process. If the gateway host/container runs in
a non-UTC zone, those thresholds silently shift by the UTC offset — jobs can
expire or be reclaimed hours early/late.

**Run the gateway, the migrator and PostgreSQL in UTC.** The reference
`docker-compose.yml` sets `TZ: UTC` on all three services; for bare-metal or
VM deployments set `TZ=UTC` in the service environment (systemd:
`Environment=TZ=UTC`, and consider `timedatectl set-timezone UTC`).

Verification (must be ≈ 0):

```sql
SELECT now() AT TIME ZONE 'UTC' AS db_now_utc;
```

```bash
date -u +%s   # host/app epoch vs. db_now_utc rendered in UTC
```

### Reference TLS deployment

The repository's `docker-compose.yml` runs the gateway privately behind Caddy. Set
`GATEWAY_DOMAIN` to a DNS name pointing at the host. Caddy terminates HTTPS and forwards both
normal HTTP traffic and `/api/agent/ws` upgrades to `gateway:3000`.

```text
Internet :443 (HTTPS/WSS)
        |
      Caddy
        |
 gateway:3000 (private Docker network)
```

Only Caddy publishes ports 80/443. Odoo branch configuration and Windows agent configuration
reject plaintext `http://` gateway URLs outside an explicit development-only opt-in.

### Request size limits

The application rejects mutating `/api/*` requests above 8 MiB using both early
`Content-Length` validation and a streaming byte counter for chunked requests. Reverse proxies
should retain an equivalent or stricter limit.

### Scaling notes

* Job claiming is safe across processes: `FOR UPDATE SKIP LOCKED` in a transaction means two
  gateway instances can never hand the same job to two agents.
* PostgreSQL `LISTEN/NOTIFY` wakes instances for new and requeued jobs, with reconnect backoff
  and polling remaining as the recovery path.
* WebSocket sockets are still **per process** (`agentSockets` is an in-memory map). An agent may
  have sockets on one or more instances; the shared database claim prevents duplicate ownership.
* `next build` does not need the database; the runtime does.

### Health and monitoring

* `GET /api/health` — unauthenticated liveness.
* Useful queries: jobs stuck in `claimed` (`claimed_at < now() - interval '90 seconds'`),
  jobs with elevated retry counts, and jobs carrying `AGENT_RESTART_DURING_PRINT`.
* Gateway logs warn on failed WebSocket pushes, sync rollbacks and unknown acks.

### Backups

PostgreSQL holds all configuration and job history. Use scheduled PostgreSQL backups and test
restore on a disposable instance before production. Agent hosts keep only their own
`config.yaml`, `printers.json` and local queue.

## 2. Agent (Windows)

Deploy the MSI/NSIS bundle from the `Build Windows Installer` workflow to each PC that has
printers, then pair it with the gateway (see [../INSTALLATION.md](../INSTALLATION.md)).
Only outbound HTTPS/WSS is needed; no inbound firewall rules.

Recommended per-site checklist:

1. Install and start the service (`-service install` + `-service start`).
2. Pair with a branch-scoped numeric six-digit pairing code.
3. Run discovery and verify capabilities in the dashboard.
4. The crash policy is safe-by-default: `agent.reprint_after_crash: false` refuses automatic
   reprint after an interrupted physical print because the previous output is unknown. Set it
   to `true` only when the business explicitly accepts at-least-once delivery and possible
   duplicate paper.
5. If PDF printing must be deterministic, install a PDF helper and set
   `agent.pdf_print_command`; PDF handlers receive a dedicated 120-second budget.

## 3. Odoo

Install the addon on the Odoo server, configure one branch per physical location with its
own API key, and let the crons keep both sides in sync. Gateway URLs must be HTTPS in production.
The addon automatically sends the current Odoo database name as `X-Odoo-Database`. Pointing two
independent Odoo databases at the same Gateway is unsupported and must be treated as a deployment
error, even when their native company ids happen to overlap.

## 4. CI/CD

The CI workflows run typecheck, lint, unit/integration tests, PostgreSQL migrations, Go vet/tests/
race tests, Odoo 19 tests, supply-chain scans, immutable Action pin checks, and build validation.
The Windows workflow additionally builds and smoke-tests MSI/NSIS artifacts; production `main`
runs require Authenticode signing secrets and verify signatures.

## 5. Release checklist

1. `npm ci` (must satisfy the repository's Node engine)
2. `npm run typecheck && npm run lint && npm test && npm run build`
3. Run all PostgreSQL-backed suites against disposable PostgreSQL
4. `cd agent && go vet ./... && go test ./... && go test -race ./...`
5. Run Odoo 19 addon tests and XML validation
6. Apply new migrations to staging, then production
7. Confirm Caddy TLS certificate issuance/renewal and do not publish port 3000
8. Verify `ODOO_DATABASE_NAME` exactly matches the deployed Odoo database
9. Build and smoke-test the Windows installer
10. Configure/verify protected `main` and required status checks
11. Configure Windows signing secrets and verify Authenticode signatures
12. Run [../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) on real hardware before
    claiming a production-ready release
