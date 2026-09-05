# Docker deployment — Gateway + PostgreSQL

This stack runs the Next.js gateway and PostgreSQL together. The Agent connects to the gateway over HTTP/WebSocket; the Windows Agent remains installed on the client PC and is not containerized here.

## 1. Prepare the server

Install Docker Engine and the Docker Compose plugin on the Linux server, then clone the repository:

```bash
git clone https://github.com/mo7medSa3d/printer-repo.git
cd printer-repo
```

## 2. Configure secrets

Create the production environment file:

```bash
cp .env.docker.example .env
```

Set at minimum:

- `POSTGRES_PASSWORD` — strong random database password.
- `GATEWAY_JWT_SECRET` — at least 32 random characters; preferably 64+.
- `MANAGER_USERNAME` and `MANAGER_PASSWORD_HASH` — prefer the password hash over a plaintext manager password.

Generate a gateway secret with:

```bash
openssl rand -hex 32
```

The `.env` file is ignored by Git and must never be committed.

## 3. Start the stack

```bash
docker compose up -d --build
```

Compose starts PostgreSQL, waits for its health check, runs the one-shot `migrate` service, and starts the gateway only when the migration service exits successfully. The gateway itself never runs `db:migrate` during application startup. This keeps schema changes ordered and prevents application replicas from requiring schema-write privileges.

Check status:

```bash
docker compose ps
```

The expected steady state is `postgres` and `gateway` running, with `migrate` completed successfully.

Check gateway health:

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

Expected response:

```json
{"ok":true}
```

View logs:

```bash
docker compose logs -f gateway
```

Migration logs:

```bash
docker compose logs migrate
```

For a later deployment after the migration container has completed, run `docker compose up -d --build` again. Compose will recreate the one-shot migration container and apply only migrations not already recorded by Drizzle.

## 4. Persistence

PostgreSQL data is stored in the named Docker volume `postgres_data`. Recreating containers does not delete the database.

Do not run `docker compose down -v` on a production/staging database unless the database can be destroyed.

## 5. Backup

For a customer deployment, take a PostgreSQL backup before importing or changing customer data. A simple logical backup is:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backup.sql
```

Restore into a stopped/new staging database with `psql` as appropriate for the customer's backup.

## 6. Network / production exposure

For the initial staging test, port `3000` can be exposed directly. For production, put the gateway behind the customer's HTTPS reverse proxy (Nginx, Caddy, Apache, Azure Application Gateway, etc.) and expose only HTTPS publicly.

The reverse proxy must support WebSocket upgrade for `/api/agent/ws` and must enforce request-body limits for endpoints that do not provide a declared `Content-Length`.

Do not expose PostgreSQL port `5432` publicly. PostgreSQL is intentionally reachable only inside the Compose network.

## 7. Windows Agent

Install the existing Windows Agent on the PC that has access to the physical printers. Configure its gateway URL to the HTTPS gateway URL. Pair/register the Agent using the existing project flow.

The gateway does not need direct access to the physical printer. The Agent performs the local printer interaction.

## 8. Customer database testing

For a staging test with a customer's database:

1. Make a backup of the customer's database.
2. Restore the backup into the staging PostgreSQL instance.
3. Start the Compose stack so the dedicated `migrate` service applies the gateway migrations.
4. Verify `/api/health`.
5. Connect one Windows Agent.
6. Configure a test printer and branch/binding.
7. Run a test print.
8. Verify job creation, claiming, delivery, status transitions, expiry, stale-claim recovery, and the deliberate physical-print failure policy.

Do not point a production Odoo installation at this staging gateway until the end-to-end test has passed.
