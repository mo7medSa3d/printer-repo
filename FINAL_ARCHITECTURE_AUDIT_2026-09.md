# Final Architecture Audit — 2026-09

## Verdict

**Production readiness: FAIL / NOT READY**

The repository has been re-architected so the Odoo addon is an integration and routing layer rather than a second ERP/runtime inventory system. However, production readiness cannot be declared from this workspace because a real Odoo 19 runtime, live Gateway/Agent integration, Windows printer execution, and physical-printer staging E2E were not executable here.

## Before

```text
Odoo
  -> custom Branch model
  -> custom Destination model
  -> custom Document Type model
  -> custom Agent mirror
  -> custom Printer mirror
  -> custom Binding / Report Mapping
  -> Gateway branch synchronization
  -> Gateway routing
  -> Agent
  -> Printer
```

The previous design duplicated business/runtime ownership and exposed branch-oriented Gateway configuration in Odoo.

## After

```text
Odoo 19
  Gateway URL + installation API key
  native Odoo destination/report/POS context
  Print Binding: Destination + Document Type -> Printer
          |
          v
central print_router
          |
          v
Odoo durable print outbox
          |
          v
Gateway POST /api/print/jobs
          |
          v
Gateway runtime queue -> Agent -> Physical Printer
```

## Odoo models retained

- `print_gateway.gateway_config`
- `print_gateway.binding`
- `print_gateway.print_job`
- `print_gateway.print_router` (service model)
- `ir.actions.report` integration hook
- `pos.order` Gateway receipt entry point

## Odoo models removed

`print_gateway.branch`, `print_gateway.destination`, `print_gateway.document_type`, `print_gateway.agent`, `print_gateway.printer`, `print_gateway.printer_binding`, `print_gateway.report_mapping`, and the legacy branch bridge/security/compatibility/async-report extensions were removed from the addon source tree.

## Views and navigation removed

Branch management, duplicated destination/document type screens, Gateway Agent/Printer screens, report mapping screens, and legacy branch-oriented menus were removed.

The Odoo navigation now centers on:

1. Gateway Configuration
2. Print Bindings
3. Print Jobs

## APIs removed

Odoo configuration synchronization APIs were removed:

- `POST /api/odoo/sync`
- `GET /api/odoo/agents`
- `GET /api/odoo/printers`
- branch-scoped Odoo API-key authorization

## APIs retained/changed

`POST /api/print/jobs` is now an installation-key authenticated, printer-targeted execution contract. Gateway branch/destination routing fields are not accepted from Odoo.

`GET /api/print/jobs?id=...` returns Gateway runtime status for the Odoo-created job.

`GET/POST/DELETE /api/odoo/keys` implements Generate / metadata list / Revoke, with raw secret returned only on creation.

## Authentication flow

```text
Gateway Manager
  -> Generate API Key
  -> raw secret shown once
  -> Gateway stores hash

Odoo
  -> Authorization: Bearer odoo_<key>
  -> X-Odoo-Database: <database>
  -> Gateway validates hash + revoke state + tenant binding
```

## Backend print flow

```text
Odoo report action
  -> ir.actions.report.report_action()
  -> print_gateway.print_router.route_report()
  -> resolve native Odoo context
  -> resolve Print Binding
  -> render PDF
  -> persist durable Odoo outbox + idempotency key
  -> post-commit Gateway submission
  -> Gateway -> Agent -> Printer
```

For Gateway-enabled operations, errors are surfaced. The router does not call the native print path after Gateway routing has been selected.

## POS flow

Odoo 19 receipt, reprint and Restaurant Print Bill paths converge on `PosStore.printReceipt()`.

```text
POS Print / Reprint / Print Bill
  -> PosStore.printReceipt()
  -> pos.order.action_print_gateway_receipt()
  -> print_gateway.print_router.route_pos_receipt()
  -> durable Odoo outbox
  -> Gateway
  -> Agent
  -> Printer
```

The Gateway-enabled branch of the POS interceptor does not call `super.printReceipt()`, so native/browser printing is not used as a fallback on Gateway failure.

## Reliability

The Odoo outbox stores the logical print before the external request. A stable idempotency key is reused by retries. Gateway job creation also deduplicates by idempotency. Transport interruption is represented as an unknown physical outcome rather than assumed to mean "not printed".

Exactly-once physical printing is not claimed because a printer can receive bytes immediately before a network/process failure.

## Security changes

- installation-level Odoo API keys
- raw key shown once and never listed
- revoke support
- company-scoped Odoo ACL/rules
- strict Gateway URL validation
- local/private target rejection unless deployment allow-listed
- no URL credentials/query/fragment/path
- no redirects on Gateway HTTP calls
- no secret/payload logging by the addon
- Gateway runtime remains responsible for Agent/Printer authentication and rate limits
- Gateway-enabled print failures are fail-closed

## Static architecture checks

`tests/test_architecture_contract.py` verifies the final Odoo source tree contains only the retained integration models, that legacy model/view names are absent, that the manifest loads only the final views/assets, that the POS path contains no native fallback in the Gateway-enabled block, and that the central router has no Gateway branch identifier contract.

## Tests that must still execute in CI/staging

- full Vitest/typecheck/lint/build suite
- full Odoo 19 module install/upgrade and Python tests
- Gateway/PostgreSQL integration tests
- Odoo ↔ Gateway integration tests
- Sales, Invoice, Delivery, Purchase, custom report printing
- POS receipt/reprint/Restaurant Print Bill
- Gateway unavailable/auth failure/missing binding/printer unavailable
- retry/idempotency/unknown outcome
- explicit native-print mode
- Windows Agent installation/runtime
- physical printer execution across representative printer classes

## Environment limitation

The execution environment used for this audit cannot resolve GitHub for local repository cloning and has no attached Odoo 19 + PostgreSQL + Windows + physical printer staging stack. Therefore those runtime gates are not reported as passing.
