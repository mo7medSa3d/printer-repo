# Project Context — Canonical Execution Memory

Updated: 2026-09-14T15:53:06Z
Input snapshot: printer-repo-main-final-clean.zip
ZIP SHA-256: 540f1797249e7831fd3cf2296ab13e1f09ba0d3c3068c8b985f4953ca12ac9d7

## Current architecture
Odoo 19 → Print Router / Binding → Durable Odoo outbox → Gateway API → Durable Gateway queue → claim/delivery/idempotency → authenticated Go Agent → local execution ledger → Windows/network printer.

## Ownership invariants
- Odoo: business truth, company/branch/POS/report/print intent and outbox.
- Gateway: SaaS tenant/control plane, runtime agents/printers, queue, claims and audit.
- Agent: local physical execution and transport.

## Verified source-level controls
- Tenant-bound queries and composite tenant FKs.
- Central manager RBAC and server-side permission enforcement.
- Pairing-code hashing, expiry and single-use semantics.
- Claim fencing and stale-claim protection.
- Request IDs and structured audit events.
- Backend agent/printer/job entitlement checks.
- WebSocket auth/rate limits/socket caps/backpressure.
- Strict printer payload validation.
- Production TS escape-hatch casts removed from the corrected files; regression contract added.

## Current environment limitations
- No .git metadata in supplied ZIP.
- Node host: 22.16.0; project requires >=24.15.0. Node 24.21.0 is the current Node 24 LTS release as of 2026-09-09.
- Go host: 1.23.2; agent module requires Go 1.26. CI uses Go 1.27.1, a current supported patch release.
- Docker/Cargo/Rust suitable for this project unavailable.
- Odoo 19 runtime, Windows runtime and physical printer unavailable.

## Measured verification
- TypeScript parser: 165 TS/TSX files, 0 syntax errors.
- Python compileall: 34 files, PASS.
- XML parse: 9 files, 0 failures.
- gofmt: PASS.
- Dynamic Vitest/npm/build, Go tests/race, Docker, Rust/Tauri, Odoo runtime and physical E2E: NOT VERIFIED.
- Exact print latency: no trustworthy end-to-end runtime measurement available in this environment.

## Current readiness
NOT READY from this environment. The source snapshot is materially stronger and statically defensible, but runtime and physical gates remain unproven.
