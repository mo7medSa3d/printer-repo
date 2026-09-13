# Current Architecture Report

## Repository snapshot
The supplied archive is a multi-process system built around Next.js/Node.js, PostgreSQL/Drizzle, a Go Windows Agent, Tauri desktop management, WebSocket delivery, and an Odoo 19 integration.

## Existing strengths
- Runtime tables already contain `tenant_id` and composite ownership FKs for agents/printers/jobs.
- Job delivery already uses durable queue state, `FOR UPDATE SKIP LOCKED`, claim tokens, stale-claim handling, and explicit delivery attempts.
- `server.ts` uses an admission-only body guard and does not consume the Next.js request stream.
- Test-print payload generation is transport-aware for ESC/POS, ZPL, TSPL, RAW, and document transports.

## Critical gaps found in the supplied snapshot
- Manager authentication did not bind sessions to a tenant.
- Manager queries were predominantly global and therefore bypassed the tenant boundary.
- Print-job creation did not require an explicit tenant context.
- The original 0029 migration could fail on existing legacy rows because it attempted `NOT NULL` before backfill.
- Negative cross-tenant tests were present mostly as stubs.
- Full physical Windows/Odoo printer verification is not reproducible from this Linux archive alone.

## Resulting implementation direction
The patch makes tenant identity part of manager sessions, scopes manager/Odoo runtime reads and writes, requires tenant context for print-job creation, and provides a safe legacy migration that aborts instead of guessing when multiple pre-existing tenants make ownership ambiguous.
