# Odoo Print Gateway — Architectural Refactor Audit (2026-09)

## Scope

This change set was based on the requested Odoo 19 + Next.js/Gateway architecture: Odoo owns business/routing intent, while Gateway owns runtime execution. The repository was inspected before changes, including Odoo report interception, POS print entry points, Gateway authentication, print-job API, routing, runtime mirrors, tests, and documentation.

## Findings addressed in this change set

- Added `print_gateway.print_router` as a central Odoo integration entry point.
- Added a server-side POS receipt method that uses the central router.
- Patched the Odoo 19 `PosStore.printReceipt()` path so receipt printing, reprints, and restaurant paths reach the server routing decision first.
- Gateway-enabled POS errors do not fall back to native/browser printing.
- Added a POS asset entry using Odoo 19's `point_of_sale._assets_pos` bundle.
- Simplified Gateway Odoo API-key creation to an installation-level standard key; the plaintext secret is returned once and Gateway-side storage remains hashed.
- Added static contract tests for the central POS interception and key-generation contract.

## Architecture still requiring follow-up before Production Ready

The repository still contains legacy Odoo-side branch/destination/document/printer mirror models and Gateway synchronization routes. These were identified as architectural contradictions with the requested final ownership model and are intentionally not claimed as removed by this PR.

The existing report implementation also retains legacy branch-oriented routing internally. The new central router is the single entry point for the newly integrated POS path, while the report subsystem still needs a full migration of its internal model ownership and persistence layer.

A real staging Odoo 19 + POS + Gateway + Agent + physical-printer test was not executable in this environment. Therefore this branch must not be considered Production Ready solely from static inspection or CI.

## Verification requirements for merge

1. Odoo module installation and upgrade on Odoo 19.
2. POS receipt print, POS reprint, and restaurant order print with Gateway enabled.
3. Gateway failure with Gateway enabled must never invoke browser/native printing.
4. Native Odoo printing must remain available only when Gateway routing is explicitly disabled.
5. Gateway API-key generation/revocation and authentication tests.
6. Full integration test with a real Agent and representative physical printer.

## Production-readiness decision

**FAIL / NOT YET PRODUCTION READY**

Reason: legacy ownership/synchronization architecture and physical staging validation remain outstanding. The PR is an implementation step toward the requested final architecture, not a declaration that every acceptance criterion has already passed.
