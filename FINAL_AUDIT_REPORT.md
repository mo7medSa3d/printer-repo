# Final Production-Grade Audit Report

## Executive summary

This repository was refactored around a single authoritative runtime ownership hierarchy:

```text
Branch -> Agent -> Printer -> Physical Device
```

Within Gateway, `Agent.branchId` is the only Agent-to-Branch ownership relation and
`Printer.agentId` is the only Printer ownership relation. Gateway no longer stores an
independent `Printer.branchId`/`branch_id`. Any Branch shown for a Gateway Printer is
resolved through `Printer -> Agent -> Branch`.

The refactor also introduced explicit Agent and Printer lifecycle management, canonical
printer semantics, fail-closed routing and branch validation, strict registration rules,
PDF/RAW content validation, bounded auth-rate-limit retention, safer Odoo synchronization,
real-PostgreSQL CI gates, production security headers, and regression coverage.

The repository had no `.git` metadata, so a conventional `git diff` was not available.
The pre-refactor extracted repository was retained separately and the final tree was compared
against it with byte-level/path-level `diff -qr` checks. 84 repository files were changed or
added, excluding generated artifacts removed before packaging.

## Architecture before / after

### Before

The Gateway allowed duplicated printer ownership state and multiple printer semantic fields.
Legacy registration could accept client-supplied branch ownership. Agent/Printer deletion
paths were not consistently lifecycle-based. Some routing and report paths had implicit
fallback behavior. Odoo pull-sync status handling could conflate transport success and sync
success.

### After

```text
Odoo business/configuration authority
            |
            v
         Gateway
            |
            v
         Branch
            |
            v
         Agent
            |
            v
         Printer
            |
            v
    physical device / spooler / IPP
```

- Odoo is the business/configuration source of truth.
- Gateway is the runtime authority/cache for paired Agents, runtime Printers, heartbeat,
  availability, Jobs and execution/delivery state.
- Branch owns Agents.
- Agent owns Printers.
- Gateway Printer Branch is derived only through Agent.
- Gateway-created Branches remain an explicit operational/provisioning mechanism and must be
  reconciled to Odoo; they are not a second business source of truth.
- Safe cross-Branch movement is not supported as an in-place Agent mutation. The documented
  workflow is retire the old Agent identity and provision/re-pair a new Agent identity.

## Issues fixed

1. **Redundant Gateway printer Branch ownership**
   - Removed `printers.branch_id` from the Gateway schema through a fail-loud migration.
   - Printer reads, writes, routing, authorization, bindings and dashboard display derive
     Branch through `Printer.agentId -> Agent.branchId`.
   - Legacy branch ownership is rejected at write boundaries.

2. **Client-controlled Agent registration Branch**
   - Registration requires `agentId` and pairing code.
   - `branchId` and `branch_id` are rejected, never silently ignored.
   - The authoritative Branch is read from the already-known Agent record.
   - Disabled/retired/unknown/expired identities are rejected.

3. **Implicit Agent creation Branch**
   - `name` and `branchId` are mandatory for API and server-action creation.
   - Branch must exist and be enabled.
   - No default/first-Branch fallback remains.
   - Dashboard Agent creation has an explicit active-Branch selector.

4. **Non-canonical printer semantics**
   - Added `src/lib/printer-model.ts` as the canonical Gateway input model.
   - `printerType`: `physical | virtual | redirected`.
   - `deviceClass`: `thermal | laser | inkjet | label | other | unknown`.
   - `connectionType`: `network | usb | spooler | ipp | ipps`.
   - `protocol`: `raw | escpos | ipp | ipps | spooler`.
   - Legacy `type`, hardware-style legacy `printerType`, and `config.protocol` are normalized
     only at input boundaries and are not persisted as competing representations.
   - `branchId`, `branch_id` and `enabled` cannot be written to Gateway Printer records.

5. **Odoo Printer ownership model**
   - Odoo Printer owns `agent_id`.
   - Odoo Agent owns `branch_id`.
   - Odoo Printer `branch_id` is a stored related field from `agent_id.branch_id` only for
     search/indexing/display and is readonly.
   - Odoo ORM constraints reject a Printer/Agent Branch mismatch.
   - Binding constraints reject cross-Branch Printer relationships.

6. **Globally unique Gateway IDs**
   - Gateway Agent and Printer IDs are primary/global identifiers; explicit unique indexes are
     present in the hardening migration to make the invariant visible.
   - Odoo `gateway_agent_id` and `gateway_printer_id` have explicit global unique SQL constraints.
   - Odoo migration preflight detects duplicates before migration.

7. **Agent deletion -> lifecycle**
   - Added centralized lifecycle state machine: `active <-> disabled`,
     `active/disabled -> retired`.
   - `retired` is terminal.
   - Disable/retire revokes credentials and disables owned Printers transactionally.
   - Re-enabling a disabled Agent requires a fresh pairing code.
   - No normal API DELETE path remains.

8. **Printer deletion -> lifecycle**
   - Printers use the same lifecycle rules.
   - Retired Printers remain queryable for historical records.
   - New jobs are rejected for disabled/retired Printers.
   - No normal API DELETE path remains.

9. **Odoo pull synchronization semantics**
   - Pull sync now records `success`, `partial` or `failed` explicitly.
   - Non-2xx, timeout, malformed JSON and required-endpoint failures are failures.
   - Agents are the required sync section; a Printer runtime fetch/write failure after successful
     Agent sync is explicitly `partial`.
   - Agent synchronization is wrapped in a savepoint so required Agent updates do not remain
     partially committed after an Agent failure.
   - `last_successful_sync_at` is preserved separately.
   - Push sync validates the JSON success contract and rejects a non-success body even on HTTP 2xx.

10. **Dashboard database failure visibility**
    - PostgreSQL errors render an explicit `Database unavailable` state.
    - The UI no longer substitutes empty arrays and falsely displays a healthy dashboard.

11. **Dashboard Agent Branch and printer count**
    - Agent rows show Branch, status, lifecycle, last heartbeat and Printer count.
    - Printer rows show Agent, derived Branch, lifecycle, connection type, Printer type and device class.
    - Branch/Agent lookups use maps rather than repeated linear `.find()` calls.

12. **Deterministic routing**
    - Binding candidates are sorted by `priority ASC, id ASC`.
    - Cross-Branch binding ownership is fail-closed.
    - Disabled/retired Agents and Printers cannot win routing.
    - Fallback chains are auditable and deterministic.
    - No database insertion-order dependence remains.

13. **PDF vs RAW ambiguity**
    - PDF payloads must contain the `%PDF-` signature.
    - Payloads declared `raw` or `escpos` are rejected when the actual bytes begin with `%PDF-`.
    - Gateway and Go Agent implement the same content check.
    - PDF routing requires a compatible spooler or IPP/IPPS path rather than raw TCP/ESC-POS.
    - Odoo report mapping no longer relabels rendered PDF bytes as RAW.

14. **Canonical Printer API**
    - Gateway writes use the canonical printer fields above.
    - Compatibility aliases are normalized or rejected at the input boundary.
    - Canonical API responses do not persist or propagate obsolete DB aliases as independent fields.

15. **Real PostgreSQL CI gate**
    - Added `.github/workflows/ci.yml`.
    - CI uses a PostgreSQL 16 service.
    - CI runs database migrations before integration tests.
    - CI then runs lint, typecheck, tests and build.
    - Go test/vet run in a separate CI job.
    - Architecture guardrails reject an obsolete `ci/workflows` tree and obsolete Gateway printer
      Branch ownership.

16. **Odoo / hardware E2E honesty**
    - Test matrix now explicitly separates executable CI layers from Odoo, Windows and physical
      printer environments.
    - Documentation no longer claims external environments passed when they were not available.

17. **Next.js security headers**
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `X-Frame-Options: DENY`
    - restrictive `Permissions-Policy`
    - HSTS is enabled only when `NODE_ENV=production`.

18. **Authentication rate-limit retention**
    - Added `updated_at` tracking and 24-hour retention cleanup.
    - Cleanup is indexed and does not reset active lock state.
    - Login still fails closed if the shared limiter cannot be used.

19. **Branch authority**
    - Documentation now defines Odoo as business/configuration authority and Gateway as runtime authority.
    - Gateway Branch creation is explicitly operational/provisioning and must reconcile to Odoo.

20. **Odoo topology**
    - Final Odoo topology is Branch -> Agent -> Printer.
    - Binding validation uses the Printer Agent Branch relation, never a duplicated Printer Branch owner.

21. **Migration safety**
    - Gateway migration `0006_architecture_hardening.sql` checks orphaned Printers, Agents without
      Branches, Printer/Agent Branch mismatches, cross-Branch bindings and duplicate IDs before
      dropping legacy Gateway Printer columns.
    - Odoo migration `1.1.0/pre-migrate.py` performs equivalent relationship/duplicate checks before
      removing the legacy Odoo Printer ownership representation.
    - No Printer/Agent data is deleted as remediation.

22. **Agent/Printer movement**
    - Gateway Agent Branch mutation is not exposed as a normal operation.
    - Odoo Agent `branch_id` and Printer `agent_id` are protected from arbitrary ownership mutation.
    - The supported safe move is retire + re-provision/re-pair.

23. **Cascade safety**
    - Gateway ORM foreign keys do not use delete cascades for Agent/Printer relationships.
    - Odoo Agent/Printer relationships use `restrict`.
    - Historical Odoo Job references use `set null` where appropriate.
    - Normal Branch/Agent/Printer unlink is blocked by lifecycle-aware model overrides.

24. **API authorization**
    - Manager resources require Manager authentication.
    - Agent resources require Agent credentials and active lifecycle.
    - Odoo endpoints require Odoo API keys scoped to the requested Branch where applicable.
    - Ownership is resolved after authentication and before mutation.

25. **Input limits**
    - Names, IDs, ports, connection fields, JSON metadata, capability payloads and heartbeat sizes
      have bounded validation.
    - Printer config is capped at 16 KiB and capabilities at 32 KiB.
    - Heartbeat printer metadata is bounded to 256 KiB and 500 reported Printers.
    - Print payloads remain capped at 5 MiB.

26. **Idempotency**
    - Stable logical idempotency keys are backed by a PostgreSQL unique constraint.
    - Concurrent duplicates converge on the same existing Job instead of creating another logical Job.
    - Physical printing is documented as potentially at-least-once; exactly-once physical printing is
      not claimed.

27. **Historical Job preservation**
    - Gateway Jobs retain immutable Branch/Agent/Printer identifiers for the logical operation.
    - Lifecycle changes do not delete history.
    - Odoo Job links use history-preserving foreign-key policies.

28. **Odoo synchronization ordering**
    - Odoo pull order is Branch context -> Agents -> Printers, with bindings validated against both
      Branch and Printer Agent ownership.
    - Gateway push synchronization validates dependencies before mutation and does not invent missing
      Printers or ownership relationships.

29. **Documentation consistency**
    - README, API, Architecture, Database, Agent, Odoo, Security, Job Lifecycle, Testing and Production
      Readiness documents were updated to reflect the new architecture and verification scope.

30. **Regression coverage**
    - Added architectural hardening tests and real-PostgreSQL schema/lifecycle tests.
    - Expanded payload, heartbeat, lifecycle, routing, Odoo static/runtime-test sources,
      idempotency and dashboard regression coverage.

## Migrations added

### Gateway: `drizzle/0006_architecture_hardening.sql`

- Adds Agent/Printer lifecycle state.
- Adds `printers.device_class`.
- Validates legacy Printer ownership before dropping `printers.branch_id`.
- Rejects orphaned Printers/Agents and cross-Branch bindings.
- Converts legacy Printer enablement to lifecycle.
- Normalizes legacy Printer type semantics.
- Removes persisted `config.protocol` compatibility duplication.
- Adds canonical lifecycle/type/transport/protocol checks.
- Removes legacy Printer `branch_id`, `type` and `enabled` columns.
- Adds visible global uniqueness indexes for Gateway Agent/Printer identifiers.

### Gateway: `drizzle/0007_auth_rate_limit_retention.sql`

- Ensures `auth_rate_limits.updated_at` exists.
- Adds the cleanup index.
- Removes rate-limit records older than 24 hours during migration.

### Odoo: `migrations/1.1.0/pre-migrate.py`

- Validates legacy Printer -> Agent -> Branch relationships.
- Detects duplicate Gateway IDs before constraints are enforced.
- Backfills `agent_id` from the legacy Gateway Agent identifier.
- Moves Printer semantic type data to canonical fields.
- Removes obsolete duplicated Printer Branch/Agent ownership fields.
- Converts report mappings that incorrectly labeled generated PDF bytes as RAW to `pdf`.
- Never deletes Printers as a migration shortcut.

## API changes

### Agent registration

Canonical registration is:

```json
{
  "agentId": "agt_...",
  "pairingCode": "...",
  "metadata": {}
}
```

Client-supplied `branchId` / `branch_id` is rejected.

### Canonical Printer write model

```json
{
  "id": "printer_...",
  "agentId": "agt_...",
  "name": "Kitchen",
  "printerType": "physical",
  "deviceClass": "thermal",
  "connectionType": "network",
  "protocol": "raw",
  "config": {},
  "capabilities": {}
}
```

`branchId`, `branch_id`, `enabled`, legacy `type`, and nested `config.protocol` are not
independent writable Gateway Printer fields.

### Lifecycle

Agent and Printer lifecycle is mutated with explicit lifecycle operations. Normal DELETE endpoints
are absent for these resources.

## Security changes

- Server-side ownership resolution for registration, printers and routing.
- Fail-closed Branch authorization.
- Lifecycle-aware authentication for Agent endpoints.
- No arbitrary/default Branch selection.
- No arbitrary/first Printer or Agent selection as ownership repair.
- Strict payload size and content validation.
- Security headers.
- Bounded auth rate-limit retention.
- Odoo API keys remain Branch-scoped.
- Cross-Branch bindings are rejected.

## CI changes

Authoritative workflows are under:

```text
.github/workflows/ci.yml
.github/workflows/build-windows.yml
```

`ci/workflows` is not used.

`ci.yml` includes:

1. Node dependency installation.
2. PostgreSQL 16 service.
3. Real migrations via `npm run db:migrate`.
4. Lint.
5. Typecheck.
6. Unit/integration tests.
7. Production build.
8. Go test.
9. Go vet.
10. Architecture guardrails.

The CI job is intentionally stronger than a mocked database test: migrations are executed against
the PostgreSQL service before database-backed tests.

## Tests added / changed

New primary regression suites:

- `tests/architecture-hardening.test.ts`
- `tests/architecture-pg.test.ts`

Expanded suites include:

- `tests/payload.test.ts`
- `tests/auth-rate-limit.test.ts`
- `tests/heartbeat-enabled.test.ts`
- `tests/routing-availability.test.ts`
- `tests/phase2-routing-fallback.test.ts`
- `tests/print-idempotency.test.ts`
- `tests/e2e-job-flow.test.ts`
- `tests/odoo-addon-static.test.ts`
- `tests/regression-critical.test.ts`
- Odoo runtime tests under `odoo_addons/print_gateway/tests/`
- Go payload and Agent protocol coverage under `agent/internal/`

The Odoo test suite now also includes transport-failure cases for pull synchronization.

## Commands executed and exact results

### Static/configuration validation

- `python3 -m compileall -q odoo_addons/print_gateway` -> **PASS**.
- YAML parsing of `.github/workflows/*.yml` -> **PASS**.
- JSON parsing of `package.json` -> **PASS**.
- JSON parsing of `drizzle/meta/_journal.json` -> **PASS**.
- `gofmt` on modified Go files -> **PASS**.
- Final architecture guard checks -> **PASS**.
- Final generated-artifact cleanup check -> **PASS**.

### Node

- `npm ci` -> **UNABLE TO COMPLETE**; dependency installation timed out.
- `npm ci --offline` -> **FAILED/UNAVAILABLE** because the local npm cache is missing required packages.
- `npm test -- --run` -> **EXIT 127** (`vitest: not found`).
- `npm run lint` -> **EXIT 127** (`eslint: not found`).
- `npm run typecheck` -> **EXIT 2**. The workspace lacks installed Node package/type dependencies, producing module-resolution/type-environment errors. Initial real errors found during the refactor (duplicate object properties and invalid readonly-array `.has()` calls) were fixed before the final package was created.
- `npm run build` -> **EXIT 127** (`next: not found`).

### PostgreSQL

- Real PostgreSQL-backed execution was **NOT AVAILABLE** in this workspace: `psql` and Docker were unavailable and no PostgreSQL service was running.
- The repository includes a real PostgreSQL test suite and CI service; those tests were not claimed as locally passed.

### Go

- `go test ./...` -> **EXIT 1** because required modules could not be downloaded from `proxy.golang.org` due unavailable network/DNS.
- `go vet ./...` -> **EXIT 1** for the same dependency-download/network condition.
- Go source formatting -> **PASS**.

### Odoo

- Python syntax/bytecode compilation -> **PASS**.
- Odoo runtime tests -> **NOT EXECUTED** because an Odoo runtime/database environment was unavailable.
- XML workflow/config files were parsed successfully during the static validation pass.

### Windows / Tauri / physical printers

- Windows installer/E2E -> **NOT EXECUTED** in this Linux workspace.
- Windows spooler -> **NOT EXECUTED**.
- USB printer -> **NOT EXECUTED**.
- Network/IPP physical printer -> **NOT EXECUTED**.

## Verification classification

### Verified locally

- Source/schema/configuration static validation listed above.
- Architectural guardrails.
- Python/Odoo syntax.
- YAML/JSON configuration syntax.
- Final repository hygiene checks.

### Defined but not executable locally

- Node unit/integration suite.
- Real PostgreSQL integration suite.
- Go test/vet.
- Odoo runtime tests.
- Windows/Tauri packaging.
- Physical printer tests.

### CI/external environment dependent

- Real PostgreSQL migrations and database integration tests.
- Node lint/typecheck/build after dependency installation.
- Go test/vet.
- Odoo integration.
- Windows installer and Windows spooler.
- IPP/network printer.
- USB printer.

No unavailable external environment is described as passing.

## Backward compatibility notes

- Legacy printer input aliases may still be parsed at defined compatibility boundaries, then normalized
  immediately into the canonical model.
- Legacy `branchId`/`branch_id` Printer ownership is intentionally rejected rather than silently accepted.
- Legacy `enabled=false` data is migrated into Printer lifecycle `disabled`.
- Legacy hardware-valued Printer `printerType` data is migrated to `deviceClass` with
  `printerType=physical`.
- Legacy `config.protocol` is read only for normalization and is removed from persisted canonical config.
- Odoo retains a derived stored `printer.branch_id` because ORM search/indexing may benefit from it;
  it is readonly and computed from `agent_id.branch_id` and is not a second ownership source.
- Agent Branch movement is not preserved as an unsafe mutable operation. Retire and re-pair is the
  compatibility-safe replacement.

## Remaining limitations

1. Full Node verification cannot be completed in this workspace without installing the repository's
   dependencies.
2. Real PostgreSQL execution cannot be completed without a PostgreSQL service.
3. Go test/vet cannot complete without dependency-download access or a populated module cache.
4. Odoo runtime tests need a real Odoo deployment/database.
5. Windows/Tauri installer verification needs a Windows runner.
6. Physical printing needs real spooler/USB/network/IPP hardware.
7. The repository contains no `.git` metadata, so the final diff was verified against the original
   extracted tree rather than an actual Git working tree.

## Recommended deployment / migration order

1. Take a full PostgreSQL backup and capture the current Odoo database backup.
2. In a maintenance window, run the Gateway hardening migration `0006` first. If it fails because of
   orphaned Printers, missing Agent Branches, Branch mismatches, cross-Branch bindings or duplicates,
   stop and remediate/reassign/retire; do not delete records or assign a default Branch.
3. Run Gateway migration `0007` for rate-limit retention.
4. Deploy the corrected Gateway application and its CI-validated dependencies.
5. Upgrade the Odoo `print_gateway` addon and run its `1.1.0` pre-migration. Resolve any preflight
   failure before proceeding.
6. Run Odoo -> Gateway synchronization in dependency order: Branches, Agents, Printers, Bindings.
7. Re-pair disabled Agents where reactivation is required. Retired Agent identities are terminal and
   must be replaced with new identities.
8. Verify Branch-scoped API keys and routing bindings before enabling production traffic.
9. Run the PostgreSQL-backed CI/integration suite against the deployed release.
10. Execute the Odoo, Windows, network/IPP and USB test matrix appropriate to the deployment
    environment before declaring that external E2E layers are verified.

## Production-readiness statement

This repository is **not declared generally production-ready from this workspace verification alone**.
The refactor and guardrails are implemented, but production acceptance still requires the unavailable
runtime/environment checks listed above, especially real PostgreSQL, Odoo, Windows and physical-printer
validation.
