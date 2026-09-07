# Final Architecture Audit — 2026-09

## Verdict

**Production readiness: FAIL / NOT READY**

The PR has been reworked around the requested ownership boundary and the verified Odoo 19 print entry points. Production readiness remains blocked because this session has not executed a real Odoo 19 staging stack, browser POS session, live Gateway/Agent, or physical printer E2E, and the CI run for the latest head has not produced completed results yet.

## Before

```text
Odoo
  -> custom Branch / Destination / Document Type models
  -> Agent / Printer mirrors
  -> Printer Binding / Report Mapping
  -> Gateway branch synchronization
  -> Gateway runtime
```

This duplicated ERP/business context and Gateway runtime ownership.

## After

```text
Odoo 19
  -> native company/branch + business/report/POS context
  -> Print Binding
  -> Central Print Router
  -> durable Odoo print outbox
  -> Gateway URL + installation API key
  -> Gateway runtime queue
  -> Agent
  -> Physical Printer
```

Gateway owns only runtime execution. Odoo remains the business source of truth.

## Ownership model

| Concern | Owner |
|---|---|
| Existing companies / branches | Odoo |
| Business records | Odoo |
| Existing POS/report/destination context | Odoo |
| Print intent | Odoo |
| Print bindings / outbox | Odoo addon |
| API credential used for Gateway | Odoo addon configuration; secret is created/revoked by Gateway |
| Agents / pairing / heartbeats | Gateway |
| Runtime printers / capabilities | Gateway / Agent |
| Runtime queue / claims / delivery / status | Gateway |
| Physical execution | Agent |

No Gateway Branch model or branch synchronization remains active.

## Odoo module surface

Retained production models:

- `print_gateway.gateway_config`
- `print_gateway.binding`
- `print_gateway.print_job`
- `print_gateway.print_router` as the service/routing authority
- `ir.actions.report` interception
- `pos.order` Gateway receipt entry point

Removed from the active addon source tree: Branch, Destination, Document Type, Agent, Printer, Printer Binding, Report Mapping, branch bridge/security/compatibility extensions, and async-report architecture.

## Odoo UI

Navigation is exactly:

```text
Print Gateway
├── Gateway Configuration
├── Print Bindings
└── Print Jobs
```

The binding form references real Odoo context rather than recreating it. Company/branch context filters native POS configurations and operation types. Document type is derived from the selected Odoo report/model. Runtime printer choices are populated from the authenticated Gateway runtime-printer endpoint. Users are not required to enter internal printer IDs.

The module does not expose branch creation, deletion, rename, Gateway Branch ID, agent provisioning, printer provisioning, destination CRUD, or document-type CRUD.

## Synchronization / discovery

There is no business-entity synchronization in the new architecture. Odoo references its own native records directly. Gateway exposes only sanitized runtime printer information needed to build a binding; Odoo cannot create or manage those printers through that endpoint.

## Backend print matrix

| Print action | Odoo execution path | Intercepted | Central Router | Gateway | Browser/PDF dialog |
|---|---|---:|---:|---:|---:|
| Sales Order | `ir.actions.report.report_action()` | YES | YES | YES | NO when Gateway enabled |
| Invoice | `ir.actions.report.report_action()` | YES | YES | YES | NO when Gateway enabled |
| Delivery / Inventory report | `ir.actions.report.report_action()` | YES | YES | YES | NO when Gateway enabled |
| Purchase quotation/order | `ir.actions.report.report_action()` | YES | YES | YES | NO when Gateway enabled |
| Custom report actions | `ir.actions.report.report_action()` | YES | YES | YES | NO when Gateway enabled |
| POS sale-details direct report | `/pos/sale_details_report` -> `_render_qweb_pdf()` | YES, targeted controller override | YES | YES | NO when Gateway enabled |

Low-level `_render_qweb_pdf()` is intentionally not globally intercepted because it is also used for non-print report generation. A global hook would conflate attachment/email/report rendering with print intent.

## POS execution matrix

Odoo 19 `PosStore.printReceipt()` renders `OrderReceipt` with `basic_receipt` and calls the POS printer service with `webPrintFallback: true`. Odoo documentation states that when no receipt printer is configured, Print Full Receipt can invoke browser printing. The addon patches this actual method and never calls native printing when Gateway mode is enabled.

| POS action | Actual Odoo path | Current handling | Browser fallback |
|---|---|---|---|
| Print Full Receipt | `PosStore.printReceipt({ basic:false })` | Gateway router | NO in Gateway mode |
| Simplified Receipt | `PosStore.printReceipt({ basic:true })` | Gateway router; visual parity requires staging proof because Odoo renders `basic_receipt` in the frontend | NO in Gateway mode |
| POS Reprint | receipt screen -> `printReceipt()` | Gateway router | NO in Gateway mode |
| Restaurant Print Bill | POS bill flow -> `printReceipt()` | Gateway router | NO in Gateway mode |
| Automatic Receipt Printing | payment flow -> receipt printing path | Gateway router when the path calls `printReceipt()` | NO in Gateway mode |
| Kitchen / Order Preparation | `sendOrderInPreparation()` -> `printChanges()` -> `printOrderChanges()` -> POS printer service | INTERCEPTED AND FAIL-CLOSED; not falsely claimed as Gateway-routed | NO in Gateway mode |

The kitchen/preparation path is separate from `printReceipt()`. The current implementation deliberately blocks it when Gateway mode is enabled because no equivalent Gateway payload/binding contract has been proven yet. This is a supported safety boundary, not a silent fallback.

## POS printer architecture considered

Odoo 19 supports ePOS network printers through local-network browser communication and printer services, and also supports IoT-based printer integration. These are downstream native execution mechanisms. The Gateway-enabled branch bypasses that service entirely; it does not attempt to convert Gateway failures into ePOS, IoT, or browser printing.

## No-silent-fallback contract

When Gateway is enabled:

- missing binding -> explicit Odoo error
- Gateway authentication failure -> explicit error
- Gateway unavailable/timeout -> explicit error and `unknown` physical outcome where delivery may have happened
- printer unavailable/capability mismatch -> explicit error
- no `super().report_action()` after Gateway routing failure
- no native POS printer call
- no `window.print()`
- no browser PDF navigation

Native Odoo printing is allowed only when Gateway is explicitly disabled.

## Gateway API

### Health
`GET /api/odoo/health` — authenticated Odoo installation key plus database binding.

### Runtime printers
`GET /api/odoo/printers` — authenticated, read-only, sanitized runtime printer list used by Odoo binding selection.

### Print
`POST /api/print/jobs`

```json
{
  "printerId": "runtime-printer-id",
  "documentType": "receipt",
  "destination": "Main POS",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "..."
  },
  "idempotencyKey": "stable-for-one-logical-operation"
}
```

No Gateway branch ID, business destination entity ID, document-type entity ID, or printer-creation data is accepted.

### Status
`GET /api/print/jobs?id=<jobId>` — authenticated runtime status lookup.

## API key lifecycle

Gateway manager creates the installation key, displays the raw value once for copy, stores only its cryptographic hash, and supports revocation. Odoo stores the credential needed to connect and never logs it.

## Reliability

The Odoo outbox row is committed before external submission. The same logical operation retains the same idempotency key across retries. A request interruption is represented as an unknown physical outcome rather than definitive failure. Gateway-side idempotency prevents a retry from becoming a second logical job.

Exactly-once physical printing is not claimed; the system instead provides durable logical intent plus idempotent reconciliation.

## Security

- installation-level key authentication
- revoke state checked on every request
- database binding via `X-Odoo-Database`
- company-scoped Odoo access rules
- Gateway URL scheme/host/userinfo/query/fragment/path validation and SSRF controls
- redirects disabled on Odoo -> Gateway calls
- payload and secret logging avoided
- runtime API rate limiting
- idempotency conflict detection

## Code / repository cleanup

The active source tree no longer contains the old Gateway branch business API surface. The deleted PR paths include branch APIs, Odoo business sync, duplicated branch/destination/document/printer/agent models, mapping views, branch synchronization code, async report compatibility layers, and their associated UI/menu architecture.

Historical audit documents may still mention the removed architecture as a description of the pre-refactor state; they are not runtime code or supported configuration paths.

## Verification status

### Repository inspection
**DONE.** PR #51 was inspected at its current head and the active addon/source tree was reviewed for ownership boundaries, routing, POS integration, API surface, migration shape, security controls, and test guards.

### Odoo 19 source research
**DONE.** Official Odoo 19 source/documentation was checked for `ir.actions.report`, POS `PosStore.printReceipt()`, `basic_receipt`, receipt printing, browser fallback, preparation/kitchen printing, the direct POS sale-details controller, and ePOS/IoT/LNA printer architecture.

### Automated tests
**NOT PROVEN FOR CURRENT HEAD.** The latest branch head has triggered CI workflows, but this session has not received completed pass/fail results for the newest commit. No local clone/test execution was possible in the workspace.

### Staging / browser / physical printer
**NOT EXECUTED.** No accessible Odoo 19 staging instance, browser POS session, live Gateway/Agent deployment, Windows runtime, or physical printer was available.

## Final status

**FAIL / NOT PRODUCTION READY**

The architecture has been reworked to the requested ownership model and the known bypass in Odoo 19 `/pos/sale_details_report` has been intercepted. The implementation must remain FAIL until CI passes on the final head and staging proves the end-to-end flows, especially POS Full/Simplified/Reprint/Restaurant/automatic receipt behavior and representative physical printer execution. Kitchen/order-preparation remains explicitly fail-closed rather than falsely reported as universally Gateway-routed.
