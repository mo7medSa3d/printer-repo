# Deployment

## 1. Gateway

### Requirements

* Node ≥ 24.20 (`.nvmrc` / `.node-version` and `engine-strict=true` enforce the supported runtime), PostgreSQL 14+.
* One process serves both HTTP and the agent WebSocket (`server.ts`). In the reference production
  deployment the gateway listens privately on port `3000`; Caddy is the only public entry point.
* Production traffic is HTTPS at Caddy on ports 80/443. Do not expose gateway port 3000 publicly.

### Steps

```bash
npm ci
npm run db:migrate
npm run build
NODE_ENV=production npm start
```

Environment: `DATABASE_URL`, `GATEWAY_JWT_SECRET` (≥ 32 chars), `MANAGER_USERNAME`,
`MANAGER_PASSWORD_HASH` (preferred), `GATEWAY_DOMAIN`, optional `PORT`/`HOSTNAME`.
Full list: [CONFIGURATION.md](CONFIGURATION.md).

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
8. Build and smoke-test the Windows installer
9. Configure/verify protected `main` and required status checks
10. Configure Windows signing secrets and verify Authenticode signatures
11. Run [../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) on real hardware before
    claiming a production-ready release
