# EXHAUSTIVE FORENSIC AUDIT — 2026-09-13

## Scope

Repository snapshot audited: `printer-repo-main` from the supplied exhaustive-audit ZIP.

Inventory: **454 files**, **99 non-file tree entries**, **444 UTF-8 text files**, **10 binary files**, approximately **80,421 text lines**.

The audit is divided into the requested four stages. Every file in the inventory was opened/read by the static audit pass and included in the final SHA-256 manifest. No source file was omitted intentionally.

## Stage 1 — Discovery & Dependency Audit

### Runtime baseline observed in audit environment

| Runtime/tool | Project requirement/pin | Audit environment | Result |
|---|---|---|---|
| Node.js | >=24.15.0; `.nvmrc`/`.node-version` = 24.21.0 | 22.16.0 | **NOT VERIFIED** — environment mismatch |
| npm | lockfile v3-compatible | 10.9.2 | static lockfile readable |
| Go | go 1.26 | 1.23.2 | **NOT VERIFIED** — toolchain too old |
| Python | Odoo scripts | 3.13.5 | syntax validation available |
| Rust/Cargo | rust-toolchain 1.98.1 | unavailable | **NOT VERIFIED** |
| Docker | required for integration/Odoo/DB runtime | unavailable | **NOT VERIFIED** |
| PostgreSQL | compose 16.15 | unavailable | **NOT VERIFIED** |
| Odoo | 19.x | unavailable | **NOT VERIFIED** |
| Windows | Agent/Spooler/Session 0 | unavailable | **NOT VERIFIED** |

### JavaScript dependency baseline

Key current stable checks performed against npm/package official sources:

- Node 24.21.0 is the current LTS line; Node 26.8.2 is current. The repository's Node 24.21.0 pin is therefore appropriate for the declared runtime baseline.
- React and react-dom 19.3.0 are current stable.
- Next.js 16.3.4 is newer than the patched 16.2.x releases called out in the 2026 Next.js security notices reviewed.
- Drizzle ORM 0.45.2 contains the fix for GHSA-gpj5-g38j-94v9 affecting <=0.45.1.
- esbuild override 0.28.2 is above the patched 0.28.1 release for the Windows dev-server arbitrary-file-read advisory reviewed.
- pg 8.23.0, tsx 4.23.13, postcss 8.5.28, tailwindcss 4.3.3, tailwind-merge 3.6.0, Vite 8.2.2, @vitejs/plugin-react 6.1.1, nanoid 6.0.1 are on the currently published stable lines checked.
- The repository declares TypeScript `^5.7.2` while package-lock resolves 5.9.3; the latest stable npm release checked is TypeScript 7.0.2. This was **not** force-upgraded because a major compiler upgrade without the required Node/dependency runtime is not safely certifiable in this environment.
- The repository declares lucide-react `^1.41.0`; current npm latest checked is 1.45.0. This is an upgrade candidate, not a security finding.
- The repository declares Vitest `^4.1.11`; current npm latest checked is 5.0.0. This is an upgrade candidate, not applied without a full dependency/install/test run.

### Go dependency baseline

Direct modules were inspected. Several modules in the Agent are not latest-published lines according to pkg.go.dev, including go-pdfium, wazero, gosnmp, zeroconf, kardianos/service, and go-sqlite3. They remain **upgrade candidates** because the available Go 1.23 toolchain cannot validate the project's Go 1.26 module or Windows build. No speculative major upgrade was committed.

### Database / Odoo / framework references

PostgreSQL 16.15 remains the latest minor for PostgreSQL 16 and the major line is supported. Odoo 19 guidance reviewed confirms Owl as the recommended frontend framework for new development; the addon uses current `@odoo`/Owl-era APIs on inspected surfaces and no banned legacy `web.Widget`, `web.AbstractAction`, `@api.multi`, `@api.one`, or `.include()` usage was found in the addon source scan.

## Stage 2 — Line-by-line / Static File Audit

### Structural parser gates

- JavaScript/TypeScript/TSX/JSX/MJS/MTS/CJS: **174 files; 0 parser diagnostics** using the available TypeScript parser.
- Python: **34 files; 0 AST parse errors**.
- XML: **9 files; 0 parse errors**.
- JSON: **8 files; 0 parse errors**.
- Go formatting: **PASS** (`gofmt -l` produced no files).
- Shell syntax: **PASS** for all tracked `.sh` files.
- Relative local import existence scan: **PASS** on the project source graph.
- Odoo manifest asset/reference checks: **PASS**.
- Drizzle migration filename/journal consistency: **PASS**, entries 0000–0031 match on-disk SQL files.
- Placeholder scan: **PASS** for source markers such as TODO/FIXME/XXX; normal comments and explicit migration-history wording are not classified as unfinished implementation.

### Confirmed refactoring/fix work retained in this snapshot

1. Tenant scoping is present on manager dashboard queries and destructive manager actions.
2. Agent lifecycle transitions require the manager tenant in the current implementation path.
3. Odoo runtime-printer lookup scopes Agent and Printer rows by the authenticated key's tenant.
4. Print-job submission uses API-key tenant identity and tenant-aware idempotency.
5. Composite tenant ownership constraints exist for the critical Gateway relationships.
6. Migration 0028–0031 reconcile the tenant rollout and ownership constraints.
7. The Agent discovery pipeline contains bounded sub-contexts and recovery guards around independent discovery sources.
8. WSD has normative and compatibility probe variants with explicit tests.
9. PDF rendering uses the embedded PDFium path and is explicitly documented as requiring Windows runtime verification.

### Findings requiring explicit handling

**F-001 — Runtime test environment mismatch (P0 release gate, not a code defect).**
The repository requires Node >=24.15.0 and Go 1.26, while this audit container only has Node 22.16.0 and Go 1.23.2; Cargo/Docker/Odoo/Windows are unavailable. Full production certification cannot be claimed here.

**F-002 — Dependency freshness candidates (P2 maintenance).**
TypeScript, lucide-react, Vitest, and multiple Go modules have newer stable releases. These are modernization opportunities, not proven runtime defects. Major dependency updates require a valid release toolchain and full regression run before adoption.

**F-003 — Documentation stale statement corrected.**
`PRINTERS.md` previously described mDNS/SNMP/WSD as not implemented. Current Agent source contains implementations and tests for those paths. The documentation was corrected to match the current source-of-truth.

**F-004 — Manager authentication remains deployment-global by design (Architecture decision; P1 if per-tenant manager identity is required).**
`manager-auth.ts` authenticates a configured manager credential and then binds the resulting session to the tenant resolved from the trusted host. This is consistent with the repository's stated platform-manager model, but it is not a tenant-membership identity system. No change was made because converting it to user/membership auth would alter the deployment security model and requires an explicit migration of manager identities.

**F-005 — Discovery docs correctly distinguish “discovery” from live test probing.**
The dashboard's `test-connection` path remains cached/reachability-oriented; physical printer probing remains unavailable to the Gateway because the Agent owns LAN access. This is an intentional boundary, not a missing implementation.

## Stage 3 — Inter-module Cohesion & Integration

Static cross-module checks covered:

- TypeScript/TSX relative imports and source-level module references.
- Odoo Python imports and addon manifest/resource references.
- Gateway schema-to-route references and tenant identifier propagation.
- Agent package structure and Go source formatting/import syntax.
- Drizzle migration order/journal alignment.
- CI / Docker / runtime configuration presence.

The primary architecture boundary remains: Odoo owns business routing decisions; Gateway owns runtime inventory/queue/fencing; Agent owns local printer execution. The repository documentation and inspected source use the same ownership model.

Potentially unreachable/unused files were not deleted automatically because proving deadness from static text alone is insufficient for runtime/plugin/installer entry points. Such candidates are documented for later proof rather than risk destructive cleanup.

## Stage 4 — Execution & Packaging Gate

### Automated gates actually executed

- Complete file inventory/read/hash pass: **PASS** (454 files).
- JS/TS parser gate: **PASS**.
- Python AST gate: **PASS**.
- XML parser gate: **PASS**.
- JSON parser gate: **PASS**.
- Go `gofmt` gate: **PASS**.
- Shell syntax gate: **PASS**.
- Final source-manifest generation: **PASS**.

### Gates not executable in the current environment

- `npm ci` / Next build / Vitest full suite: **NOT VERIFIED** because Node 22 violates the project engine requirement and node_modules are absent.
- Full Go test suite / race detector / Windows build: **NOT VERIFIED** because installed Go is 1.23.2 while the module requires Go 1.26, and Windows toolchain is absent.
- Tauri Cargo build/test: **NOT VERIFIED** because Rust/Cargo are absent.
- PostgreSQL migration execution/integration tests: **NOT VERIFIED** because PostgreSQL/Docker are absent.
- Odoo 19 TransactionCase/browser/POS execution: **NOT VERIFIED** because Odoo/Docker/browser are absent.
- Physical printer, Windows Spooler, WSD/mDNS/SNMP interoperability: **NOT VERIFIED** on physical hardware.

These are release-environment constraints, not silently converted to PASS.

## Final Checklist

- [x] Complete file tree enumerated.
- [x] Every tracked file opened/read by the static audit pass.
- [x] Every file represented in the SHA-256 manifest.
- [x] Dependency manifests inspected.
- [x] Current stable versions / advisories searched for major runtime dependencies.
- [x] Runtime compatibility compared with repository pins.
- [x] Parser/syntax gates run for every supported source language available locally.
- [x] Cross-module local references checked.
- [x] Tenant-sensitive paths rechecked.
- [x] Migration chain checked.
- [x] Stale documentation found and corrected.
- [x] No unfinished source placeholders introduced.
- [x] Full runtime/physical tests explicitly marked NOT VERIFIED where unavailable.
- [x] Final project packaged only after the above checklist completed.

## Release Verdict

**STATICALLY VERIFIED / RUNTIME CERTIFICATION PENDING**

The source snapshot passes the available exhaustive static gates, but the project must not be represented as fully production-certified until the CI/staging environment runs Node 24.21.0, Go 1.26+, PostgreSQL 16, Odoo 19, Cargo/Tauri, and Windows physical-printer tests.
