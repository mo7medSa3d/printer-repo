# Deployment

## 1. Gateway

### Requirements

* Node ≥ 22 (`.nvmrc` / `.node-version` pin the CI version), PostgreSQL 14+ (developed and
  tested against PostgreSQL 18).
* One process serves both HTTP and the agent WebSocket (`server.ts`), so exactly one port
  must be exposed (default `3000`).
* TLS is expected to be terminated in front of the process (reverse proxy or platform).

### Steps

```bash
npm ci
# apply migrations in order
for f in drizzle/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
npm run build
NODE_ENV=production npm start
```

Environment: `DATABASE_URL`, `GATEWAY_JWT_SECRET` (≥ 32 chars), `MANAGER_USERNAME`,
`MANAGER_PASSWORD_HASH` (or `MANAGER_PASSWORD`), optional `PORT`/`HOSTNAME`.
Full list: [CONFIGURATION.md](CONFIGURATION.md).

### Reverse proxy

The proxy **must** forward WebSocket upgrades for `/api/agent/ws`, otherwise agents fall
back to polling (jobs still print, with up to ~10 s extra latency):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # "upgrade" for WS requests
    proxy_set_header Host       $host;
    proxy_read_timeout 120s;                            # > 30s ping interval
}
```

Print payloads are up to 5 MiB base64 — allow a request body of at least ~8 MB
(`client_max_body_size 8m;`).

### Scaling notes

* Job claiming is safe across processes: `FOR UPDATE SKIP LOCKED` in a transaction means two
  gateway instances can never hand the same job to two agents.
* WebSocket sockets are **per process** (`agentSockets` is an in-memory map). With multiple
  instances behind a load balancer, an agent is connected to exactly one of them; a job
  created on another instance is not pushed over that socket and is delivered by the agent's
  poll (≤ 10 s) — correct, just slower. Sticky routing per agent, or a shared pub/sub, would
  be required for push in every instance.
* `next build` does not need the database; the runtime does.

### Health and monitoring

* `GET /api/health` — unauthenticated liveness plus agent/printer/job counters.
* Useful queries: jobs stuck in `claimed` (`claimed_at < now() - interval '90 seconds'`),
  jobs with `retries >= 3`, jobs with `error like 'AGENT_RESTART_DURING_PRINT%'`.
* Gateway logs warn on failed WebSocket pushes, sync rollbacks and unknown acks.

### Backups

PostgreSQL holds all configuration and job history. Back it up as usual; there is no other
server-side state. Agent hosts keep only their own `config.yaml`, `printers.json` and local
queue.

## 2. Agent (Windows)

Deploy the MSI/NSIS bundle from the `Build Windows Installer` workflow to each PC that has
printers, then pair it with the gateway (see [../INSTALLATION.md](../INSTALLATION.md)).
Only outbound HTTPS/WSS is needed; no inbound firewall rules.

Recommended per-site checklist:

1. Install and start the service (`-service install` + `-service start`).
2. Pair with a branch-scoped pairing code.
3. Run discovery, verify capabilities in the dashboard.
4. Decide the crash policy: `agent.reprint_after_crash` (`true` default = at-least-once,
   `false` = never reprint automatically).
5. If PDF printing must be deterministic, install a PDF helper and set
   `agent.pdf_print_command`.

## 3. Odoo

Install the addon on the Odoo server, configure one branch per physical location with its
own API key, and let the crons (2 min status, 5 min pull, 5 min push) keep both sides in
sync. See [ODOO.md](ODOO.md).

## 4. CI/CD

`.github/workflows/build-windows.yml` (`windows-latest`) runs on push/PR to `main` and on
demand: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `go vet`,
`go test -count=1 -p 2`, `go test -race -count=1 -p 2`, Go builds for the agent and CLI,
Tauri icon verification, `npm run desktop:vite:build`,
`cargo tauri build --bundles nsis,msi`, MSI installation and
`scripts/smoke-test-windows.ps1`, then uploads the installers as artifacts.

`npm test` in CI runs **without** `DATABASE_URL`, so the database-backed suites are skipped
there. Run them against a disposable PostgreSQL to exercise the claim/sync/E2E paths:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
```

## 5. Release checklist

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. `DATABASE_URL=… npm test` (all suites, no skips)
3. `cd agent && go build ./... && go vet ./... && go test ./... && go test -race ./...`
4. `GOOS=windows go build ./... && GOOS=windows go vet ./...`
5. `python -m py_compile odoo_addons/print_gateway/models/*.py` and XML validation
6. Apply new migrations to staging, then production
7. Build and smoke-test the Windows installer (CI does this automatically)
8. Run [../WINDOWS_PHYSICAL_E2E.md](../WINDOWS_PHYSICAL_E2E.md) on real hardware before
   claiming a production-ready release — see [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)
