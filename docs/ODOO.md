# Odoo addon — `print_gateway`

The addon in `odoo_addons/print_gateway/` targets **Odoo 19 Community** and is tested in CI against the official Odoo 19 Community Docker image. It depends on `base, sale, account, stock, purchase, point_of_sale` and is licensed LGPL-3.

The addon is the business/configuration side of the system. The Gateway remains the runtime authority for agents, printers, heartbeats, bindings and print execution.

> Odoo 19 compatibility is verified by the repository CI installation/test job. A real customer Odoo database, Gateway instance, Windows agent and physical printer are still deployment-specific E2E environments.

## 1. Installation

1. Copy `odoo_addons/print_gateway` into an Odoo addons path.
2. Update the Apps list and install **Odoo Print Gateway**.
3. Open **Print Gateway** from the main menu.
4. Configure a Branch, then synchronize runtime Agents/Printers from the Gateway.
5. Configure destinations, document types and printer bindings.
6. Configure report mappings only after routing is valid.

The addon uses Odoo 19 `list` views and direct XML modifiers; it does not use legacy `<tree>`, `attrs` or `states` view syntax.

## 2. Architecture

`Odoo report -> durable print operation -> Odoo worker/cron -> Gateway /api/print/jobs -> Agent -> Printer`

Gateway-enabled QWeb reports are deliberately asynchronous. The interactive Odoo request validates routing and persists a render descriptor plus one idempotency key. The worker later renders the QWeb PDF and submits the real payload to the Gateway. This keeps network I/O and PDF rendering out of the interactive report request and makes retries duplicate-safe.

Because rendering happens in the worker, the printed document reflects the record state available when the queued operation is rendered, not a byte-for-byte snapshot of the report at click time.

## 3. Models

| Model | Purpose |
|---|---|
| `print_gateway.branch` | Branch/company root and Gateway connection settings |
| `print_gateway.destination` | Logical print destinations such as POS, kitchen or warehouse |
| `print_gateway.document_type` | Logical document classes and payload hints |
| `print_gateway.agent` | Read-only Odoo mirror of Gateway runtime Agents |
| `print_gateway.printer` | Read-only Odoo mirror of Gateway runtime Printers |
| `print_gateway.printer_binding` | Destination/document-type to printer routing rules |
| `print_gateway.report_mapping` | Maps an Odoo report to routing metadata |
| `print_gateway.print_job` | Durable local mirror/outbox for Gateway print operations |
| `ir.actions.report` (inherited) | Enables Gateway routing and durable async report queueing |

## 4. Security

Branch, destination, document type, agent, printer and print-job access is company-scoped by record rules. Printer bindings are editable only by Odoo system administrators and their rules remain company-scoped.

The Gateway API key is a secret, not merely a masked form field: `gateway_api_key` is restricted at the Odoo field level to `base.group_system`. Connection testing and Odoo/Gateway synchronization are also restricted to system administrators.

The addon never trusts a browser field as an authorization boundary. Routing validates the branch against the current user's companies and rejects cross-company/cross-branch destination mismatches.

## 5. Report routing

A report mapping is resolved using deterministic precedence:

1. exact `report_id`
2. external `report_xml_id`
3. technical `report_name`
4. `model_name`

The selected branch and destination must be valid and in the same routing scope. Heterogeneous multi-record reportsets are rejected rather than split implicitly across printers.

QWeb report mappings are **PDF-only**. `payload_type` remains as an explicit transport contract but its only supported value is `pdf`. RAW/ESC-POS jobs must use the direct print-job APIs with already-formatted payload bytes; the addon does not pretend that a PDF is ESC/POS.

There is no `fallback_to_normal` flag. Once a Gateway-enabled report has been queued, a render or transport failure remains a durable queued operation for retry rather than silently switching to another print path after the Odoo request has completed.

## 6. Synchronization

Gateway -> Odoo pulls Agents first, then Printers. Printer records must reference an Agent already synchronized into the selected branch. Invalid runtime payloads, ownership mismatches and malformed responses are rejected.

Odoo -> Gateway pushes branch configuration, destinations, document types and bindings one branch at a time. There is no cross-system distributed transaction; partial failures are recorded per branch for retry and reconciliation.

## 7. Background jobs

The addon provides scheduled work for job-status synchronization, branch/runtime synchronization, configuration push and retry of durable pending print operations. The pending operation keeps its original idempotency key across retries.

## 8. Odoo 19 validation

The repository CI runs the addon against the official `odoo:19.0` Community image with the same addon directory mounted into the container. The test command installs the module, enables Odoo tests and stops after initialization. This catches module-load errors, XML/view incompatibilities, model registration failures and addon test failures that static Python checks cannot detect.

The repository also keeps Node/Gateway and Go checks in the main CI pipeline and Windows packaging in the Windows workflow.

## 9. Deployment checklist

Before customer delivery, verify the actual customer's Odoo 19 Community database, Gateway URL/API key, branch mapping, report routing, Windows agent pairing, printer capabilities and at least one successful physical print per printer class that matters to the customer.

Do not claim exactly-once physical printing. A printer can receive bytes before a network failure is observed, so the end-to-end system remains potentially at-least-once at the physical device boundary.
