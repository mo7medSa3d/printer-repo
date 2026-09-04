# Development guide

How to work on this repository. Setup and operations for a deployed system are in
[../INSTALLATION.md](../INSTALLATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Toolchain

| Tool | Version | Needed for |
|---|---|---|
| Node | ≥ 22 (`.nvmrc`, `.node-version`) | Gateway, tests, desktop WebView bundle |
| PostgreSQL | 14+ (developed against 18) | Runtime and the database-backed test suites |
| Go | 1.21+ (`agent/go.mod`) | Agent and CLI |
| Rust + `cargo-tauri` v2 | stable | Desktop shell — **Windows host required** for the installer |
| Python 3 | any 3.x | Odoo addon syntax/XML checks |

You can work on the gateway alone with just Node and PostgreSQL.

## 2. Local setup

```bash
npm ci
cp .env.example .env                 # DATABASE_URL, GATEWAY_JWT_SECRET, manager credentials
createdb print_gateway
for f in drizzle/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
npm run dev                          # tsx server.ts → http://localhost:3000 (+ /api/agent/ws)
```

`npm run dev` runs the custom server (`server.ts`), so the agent WebSocket is available.
`npm run dev:next` starts plain `next dev` **without** the WebSocket — only useful for pure
UI work.

Sign in at `/login` with `MANAGER_USERNAME` / `MANAGER_PASSWORD`.

## 3. Working without hardware

Use the real Go agent and its supported local/non-Windows print simulation path. The production
Gateway no longer contains a browser-based agent simulator.

```bash
cd agent
go run ./cmd/cli -pair <CODE> -server http://localhost:3000 -config ./dev-config.yaml
go run ./cmd/agent -config ./dev-config.yaml
```

On non-Windows the spooler backend writes `.prn`/`.pdf` files to the temp directory and logs
that the print was SIMULATED; PDF printing without an `agent.pdf_print_command` fails with an
explicit "not supported on this OS" error by design.

## 4. Repository layout

```
server.ts                  custom HTTP server: Next.js + attachAgentWSS
src/app/api/**             route handlers (agent, manager, Odoo, health)
src/app/dashboard          manager dashboard (agents, printers, latest 50 jobs)
src/app/actions.ts         server actions (create/delete agent, create/test print job)
src/lib/                   payload contract, routing, job status, job delivery, auth
src/server/ws.ts           agent WebSocket server, claim-and-push, job_ack handling
src/db/                    Drizzle schema + pooled connection
src/components/            shared UI primitives (also used by the desktop app)
src/desktop/               desktop WebView UI + typed Tauri IPC layer
drizzle/                   SQL migrations + meta/_journal.json
agent/                     Go agent (cmd/agent, cmd/cli, internal/*)
src-tauri/                 Rust/Tauri shell
odoo_addons/print_gateway  Odoo addon
tests/                     Vitest suites + helpers/pg.ts + pg-concurrent-claim.mjs
scripts/                   installer, smoke test, icon generation, PG concurrency harness
docs/                      reference documentation (index in ../DOCS.md)
```

## 5. Everyday commands

```bash
npm run dev                 # gateway with WebSocket
npm run typecheck           # tsc --noEmit
npm run lint                # eslint .
npm test                    # vitest run (DB suites skip without DATABASE_URL)
npm run build               # next build
npm run db:push             # push schema.ts to a dev database
npm run db:generate         # generate a migration from schema.ts
npm run db:studio           # Drizzle Studio
npm run desktop:dev         # Vite dev server for the desktop UI (:1420)
npm run desktop:vite:build  # desktop WebView bundle → dist-desktop/
cd agent && go test ./... && go test -race ./... && go vet ./...
```

## 6. Tests

```bash
createdb printgw_test
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
```

`tests/helpers/pg.ts` applies the migrations itself, asserts the delivery-tracking columns
exist, and truncates every table between tests, so any disposable database works. Suites that
need PostgreSQL are `describe.skipIf(!hasTestDatabase)` — they skip, never fail, when the
variable is absent. Details and the full inventory: [TESTING.md](TESTING.md).

## 7. Common changes

**Add a database column**
1. Edit `src/db/schema.ts`.
2. Add `drizzle/000N_<name>.sql` with `IF NOT EXISTS`-style guards.
3. Append the entry to `drizzle/meta/_journal.json`.
4. Apply the file to a fresh database and confirm it matches `schema.ts`.
5. Document it in [DATABASE.md](DATABASE.md) (and [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md) if it
   is part of the job contract).

**Add an API route**
1. Create `src/app/api/**/route.ts`; pick the auth helper that matches the caller
   (`validateAgent`, `validateManager`, `validateOdooKey`).
2. Validate the body (Zod or explicit checks) and return real status codes — never mask a
   database failure as a 404.
3. Document it in [../API.md](../API.md); the cross-check expects every route to appear there.

**Add a printer backend**
1. Implement `Printer` in `agent/internal/printer/`; add `SupportsKind` and, when the
   document kind changes the physical path, `PrintDocument`.
2. Wire it into `factory.go` and, if it can be discovered, into `discovery.go`.
3. Add a section to [../PRINTERS.md](../PRINTERS.md) §5 with the same aspects as the others
   (protocol, kinds, configuration, capability reporting, errors, platform limits,
   discovery, verification status).
4. Never make a new backend accept `pdf` unless it can really render a PDF.

**Change the job protocol**
Both sides must move together: `src/lib/job-delivery.ts` + `src/server/ws.ts` and
`agent/internal/agent/agent.go`. Keep the flat envelope aliases so an older agent keeps
working, and update [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

**Change the payload contract**
`src/lib/payload.ts` and `agent/internal/payload/payload.go` are deliberate mirrors — change
both, keep the 5 MiB cap and the canonical-base64 behaviour identical, and update the tables
in [../API.md](../API.md) and [../PRINTERS.md](../PRINTERS.md).

## 8. Conventions

* Comments explain **why**, not what; several tests assert on documented invariants, so keep
  the reasoning next to the code.
* Errors are surfaced, never swallowed: no silent fallbacks, no "success" for an unknown
  outcome, no downgrade of a payload type.
* Ids are compared as trimmed strings; document types are compared case-insensitively in
  both routing and authorization.
* Anything that touches a shell, a temp file, or a printer name on the agent must stay
  injection-safe (argv slices, OS random temp names, name validation) — see
  [SECURITY.md](SECURITY.md) §7.
* Do not add a dependency for styling or convenience; the design tokens live in
  `src/app/globals.css` ([../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md)).
* Server components must not import `@/components/ui` (it pulls in client hooks); use
  `@/components/brand` for the server-rendered layout.

## 9. Before opening a pull request

```bash
npm run typecheck && npm run lint && npm test && npm run build
DATABASE_URL=… npm test
cd agent && go build ./... && go vet ./... && go test ./... && go test -race ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
python -m py_compile odoo_addons/print_gateway/models/*.py
git diff --check
```

Update the documentation in the same change, and keep the verification labels honest:
**VERIFIED**, **SOFTWARE VERIFIED**, **COMPILE VERIFIED**, **SIMULATED**, **NOT VERIFIED**,
**REQUIRES HARDWARE**, **REQUIRES LIVE ODOO**.
