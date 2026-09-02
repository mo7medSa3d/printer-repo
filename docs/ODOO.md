# Odoo addon — `print_gateway`

Source: `odoo_addons/print_gateway/`. Odoo 16/17/18-compatible
(`_render_qweb_pdf` is called with both the modern and the legacy signature).
Depends on `base, sale, account, stock, purchase, point_of_sale`; license LGPL-3.

> Status: everything here is **code-verified** (`python -m py_compile`, XML well-formedness,
> and the addon's own unit tests exist under `tests/`). No live Odoo instance was used in
> this repository, so end-to-end behaviour inside Odoo is **REQUIRES LIVE ODOO**.

## 1. Installation

1. Copy `odoo_addons/print_gateway` into an addons path of your Odoo server.
2. Update the apps list and install **Odoo Print Gateway**.
3. Open **Print Gateway** in the main menu (`views/menu.xml`).

The addon ships 10 views, 2 cron jobs (`data/cron.xml`), 8 default report mappings
(`data/report_mappings.xml`, `noupdate=1`), access rules
(`security/ir.model.access.csv`, `security/security.xml`) and a scoped SCSS skin
(`static/src/scss/*`, `o_pg_*` classes only — no changes to Odoo's own styling).

## 2. Models

| Model | Purpose | Key fields |
|---|---|---|
| `print_gateway.branch` | One physical location + its gateway connection | `name`, `company_id`, `gateway_url`, `gateway_api_key` (password), `gateway_branch_id`, `enabled`, `location`, `timezone`, `last_sync_at` |
| `print_gateway.destination` | Where something prints (POS, kitchen, warehouse…) | `branch_id`, `name`, `destination_type`, `zone`, `gateway_destination_id`, `enabled` |
| `print_gateway.document_type` | Logical document class (receipt, invoice…) | `branch_id`, `name`, `payload_hint` (`raw/escpos/pcl/ipp/pdf`), `gateway_document_type_id`, `enabled` |
| `print_gateway.printer` | Read-only mirror of a gateway printer | `agent_id` (**owner**, required), `branch_id` (stored *related* `agent_id.branch_id`, readonly), `gateway_printer_id`, `printer_type`, `connection_type`, `protocol`, `spooler_name`, `status`; `action_sync_from_gateway`, `action_test_print` |
| `print_gateway.agent` | Read-only mirror of a gateway agent | `branch_id` (**the** branch owner), `gateway_agent_id`, `printer_ids` (one2many on `printer.agent_id`), `status`, `last_seen_at`; `action_sync_status` |
| `print_gateway.printer_binding` | Routing rule | `branch_id`, `destination_id`, `document_type_id`/`document_type`, `printer_id`, `priority`, `enabled`; `_check_branch_consistency` (compares `printer_id.agent_id.branch_id`) |
| `print_gateway.report_mapping` | Which report prints as what | `report_id`, `report_xml_id`, `model_name`, `report_name`, `document_type_id`/`document_type_name`, `branch_id`, `destination_id`, `gateway_enabled`, `payload_type`, `priority`, `fallback_to_normal`, `active` |
| `print_gateway.print_job` | Local mirror of a gateway job | `gateway_job_id`, branch/destination/document type/printer/agent, `status`, `error`, `odoo_model`, `odoo_record_id`, `report_xml_id`, `report_name`, `report_id`; `action_sync_status`, `cron_sync_pending_jobs` |
| `ir.actions.report` (inherited) | Per-report gateway switch | `print_gateway_enabled`, `print_gateway_document_type_id`, `print_gateway_branch_id`, `print_gateway_destination_id`; overrides `report_action` |

### Printer ownership: Branch → Agent → Printer

The addon mirrors the gateway's model exactly: **the agent owns the branch, and the
printer owns nothing but its agent.**

* `print_gateway.printer.agent_id` (Many2one → `print_gateway.agent`, required) is the
  only ownership link.
* `print_gateway.printer.branch_id` is a **stored `related='agent_id.branch_id'`,
  `readonly=True`** field. It exists so the record rules in `security/security.xml` and
  `branch.printer_ids` can keep filtering by branch, but it cannot be edited and cannot
  drift — writing the agent rewrites it automatically.
* In the UI the printer's Branch is displayed but never editable. To move a printer,
  change its agent (or move the agent's branch in the gateway and re-sync); all of that
  agent's printers follow in one step.
* `gateway_printer_id` and `gateway_agent_id` are globally unique
  (`unique(gateway_printer_id)` / `unique(gateway_agent_id)`), *not* unique per branch —
  a physical printer must not be mirrored into two branches at once.
* `printer_binding._check_branch_consistency` validates against
  `printer_id.agent_id.branch_id`, matching the gateway's `CROSS_BRANCH_BINDING` check.

**Upgrading an existing install:** `migrations/1.1.0/pre-migrate.py` runs before the new
schema is applied. It refuses to upgrade — naming the offending records — if any printer
has no agent, or if a printer's stored branch disagrees with its agent's branch. Resolve
those in the old version first; the migration never guesses which branch was intended.

## 3. Configuration order

1. **Branch** — set `gateway_url` and the branch-scoped `gateway_api_key`
   (created in the gateway dashboard: `POST /api/odoo/keys`).
   Buttons: *Test Connection* (`GET /api/health`), *Sync From Gateway*, *Sync To Gateway*.
2. **Destinations** — one per physical print location in the branch.
3. **Document types** — the logical document classes you route on.
4. **Sync From Gateway** — pulls agents and printers (the gateway owns them).
5. **Printer bindings** — destination + document type → printer, with `priority` for
   fallback (lower number wins).
6. **Report mappings** — which `ir.actions.report` routes through the gateway, and as which
   document type/payload type. Alternatively tick *Gateway Printing Enabled* directly on the
   report.
7. **Sync To Gateway** — pushes branches, destinations, document types and bindings.

## 4. Report flow

```
User presses Print on a QWeb report
  → ir.actions.report.report_action()                      models/ir_actions_report.py
     → _should_route_via_gateway()  (direct report flag, or report_mapping match:
                                     report_id > xml_id > report_name > model)
     → _determine_branch()       mapping.branch_id → record.branch → company → first enabled
     → _determine_destination()  mapping.destination_id → record field → branch default
     → _determine_document_type()mapping document type → model fallback
                                 (sale.order→order, account.move→invoice,
                                  stock.picking→delivery, purchase.order→purchase_order,
                                  pos.order→receipt, else "document")
     → _generate_payload_for_report()
          _render_qweb_pdf(...)  → base64 → {"type": "pdf", "encoding": "base64", "data": …}
          payload_type=raw in the mapping ⇒ the same bytes with the legacy "raw" type
          payload_type=escpos          ⇒ UserError (there is no PDF→ESC/POS rasteriser;
                                          failing loudly beats printing garbage)
     → branch.create_print_job(destinationId, documentType, payload, … , idempotency_key)
          POST /api/print/jobs  (branch-scoped key, one uuid4 idempotency key per logical
                                 print, reused on the single automatic retry)
     → print_gateway.print_job record with gateway_job_id and report metadata
     → user sees a "Print Job Sent to Gateway" notification
```

If the report is not gateway-enabled, `report_action` falls through to standard Odoo
behaviour (normal PDF download). When the gateway call fails and the mapping has
`fallback_to_normal`, the normal download is used; otherwise a `ValidationError` surfaces the
gateway's error text.

**QWeb reports default to `payload_type = pdf`** and the gateway/agent print them through the
real PDF path. `raw` remains available for legacy setups that want the same bytes with the
old type name.

## 5. Idempotency

`branch.create_print_job` generates one `uuid4().hex` per logical print operation and reuses
it for the single automatic retry after a timeout/connection error, so a retry can never
create a second physical job. The gateway enforces uniqueness with a partial unique index on
`(branch_id, idempotency_key)` and answers a duplicate with HTTP 200 and the existing job.

## 6. Synchronisation

| Direction | Trigger | Endpoint | Behaviour |
|---|---|---|---|
| Gateway → Odoo | *Sync From Gateway* button, cron **every 5 min** | `GET /api/odoo/agents`, `GET /api/odoo/printers` | Mirrors agents/printers into Odoo (read-only). **Agents are fetched and upserted first**, then printers are attached to them by `gateway_agent_id`; a printer whose agent is unknown is skipped rather than created branch-less. Matching is by the global gateway id, so a printer or agent moved to another branch in the gateway is *moved* in Odoo too, never duplicated. Mirrors that vanish from the gateway are marked offline/disabled, not deleted |
| Odoo → Gateway | *Sync To Gateway* button, cron **every 5 min** | `POST /api/odoo/sync` | Pushes branches, destinations, document types and bindings. **Never pushes printers or a printer branch** — printer ownership lives in the gateway, so this direction cannot re-introduce the duplication. A binding whose printer derives (printer → agent → branch) to another branch is rejected |
| Gateway → Odoo | cron **every 2 min** | `GET /api/print/jobs?id=…` | Updates job status/error for non-terminal jobs (`completed → success`) |

The push is validated and applied atomically by the gateway: it either commits everything or
writes nothing. Failures come back as
`{"success": false, "error": "SYNC_VALIDATION_FAILED" | "SYNC_DEPENDENCY_MISSING",
"details": [...]}` with HTTP 400, and `branch._format_sync_error` expands those details into
the raised `ValidationError` so the user sees *which* binding/printer is at fault instead of
a raw JSON blob. Typical case: a binding references a printer that no agent has registered
yet — register/discover the printer, then sync again. **The gateway never creates printers
from Odoo data.**

## 7. Security model inside Odoo

* Branch/destination/document-type/binding **writes** are restricted to `base.group_system`;
  regular users have read access (`security/ir.model.access.csv`). This keeps
  `gateway_api_key` (a password field) out of reach of normal users.
* `_check_company_access` blocks acting on a branch belonging to another company; printing
  to another company's branch raises.
* Record rules in `security/security.xml` filter branch-owned records by company.
* Regression tests: `odoo_addons/print_gateway/tests/test_security_regressions.py`
  (cross-company reads/writes, binding permissions, cross-company printing) and
  `odoo_addons/print_gateway/tests/test_report_gateway.py`
  (mapping resolution per model, gateway failure handling, job id storage, status sync,
  real PDF payload). They require an Odoo test runner — **REQUIRES LIVE ODOO**.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `SYNC_DEPENDENCY_MISSING … printer does not exist` | The printer was never registered by an agent; run discovery on the agent PC first |
| `SYNC_VALIDATION_FAILED … does not belong to the synchronized branch` | A destination/printer/binding from another branch slipped into the payload |
| HTTP 403 on print | The API key is `read_only` or its `allowedDocumentTypes` does not contain this document type (comparison is case-insensitive) |
| HTTP 422 `CAPABILITY_MISMATCH` | The routed printer cannot render the payload type (e.g. PDF to an ESC/POS-only printer) |
| HTTP 503 `PRINTER_OFFLINE` / 409 `PRINTER_DISABLED` | The printer is offline (retry) or administratively disabled (fix configuration) |
| `Report … is mapped to ESC/POS but no PDF-to-ESC/POS conversion is configured` | Change the mapping's payload type to `pdf`, or supply pre-formatted ESC/POS |
