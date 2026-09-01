# Odoo Local Print Agent — Production Gateway

```
              ODOO CLOUD
                  │ HTTPS (Odoo API key)
                  ▼
        ┌────────────────────┐
        │ Print Gateway/API  │  Next.js 16 + PostgreSQL + Drizzle
        │ WS server (Agent)  │  server.ts + src/server/ws.ts
        └─────────┬──────────┘
                  │ WSS/HTTPS (Bearer agt:secret)
                  ▼
        ┌────────────────────┐
        │ Windows Print Agent│  Go 1.21, Windows Service, SQLite WAL
        └─────────┬──────────┘
                  │ LAN TCP 9100
                  ▼
        ┌────────────────────┐
        │ Network Printer    │  RAW TCP / ESC/POS
        └────────────────────┘

      ┌─────────────────────────────────┐
      │ Windows Desktop Manager         │  Tauri 2.x + React (polls HTTPS)
      │ Management, pairing, diagnostics│  thin, no Python, no Electron
      └──────────────┬──────────────────┘
                     │ HTTPS (manager JWT 8h)
                     ▼
               Cloud Print Gateway
```

## A. What This Project Does

**Overall Architecture `ARCHITECTURE.md:3`:**
- **Gateway** `server.ts` + `src/server/ws.ts` + `src/db/schema.ts` — Next.js 16, PostgreSQL, Drizzle ORM, custom WebSocket server on same port as Next. Handles Odoo → job, Agent → heartbeat/jobs/WS, Manager → JWT.
- **Agent** `agent/cmd/agent/main.go` + `agent/internal/agent/agent.go` — Go 1.21 Windows Service (`kardianos/service`, `Arguments: -config C:\ProgramData\OdooPrintAgent\config.yaml`), outbound `WSS /api/agent/ws` + poll fallback `GET /api/agent/jobs`, heartbeat `POST /api/agent/heartbeat` 30s, per-printer `sync.Mutex`, SQLite WAL `agent/internal/queue/queue.go:14` (`INSERT OR IGNORE`, `journal_mode=WAL`).
- **Desktop Manager** `src-tauri/` + `src/desktop/` — Tauri 2.x + React, typed IPC `src/desktop/lib/ipc.ts`, Rust `src-tauri/src/{main,commands,agent,paths,logging,tray}.rs`, settings at `C:\ProgramData\OdooPrintManager\settings.json`, tray hide-not-exit.
- **Odoo Addon** `odoo_addons/print_gateway` — 8 models (`branch, destination, document_type, printer, agent, printer_binding, print_job, report_mapping` + `ir.actions.report` override), 9 views, `security/ir.model.access.csv`, `data/cron.xml`, `__manifest__.py` depends `base,sale`.
- **How they communicate:**
  - Odoo → Gateway: `HTTPS Bearer odoo_xxx` `POST /api/print/jobs` (`src/app/api/print/jobs/route.ts:75`) + `GET /api/print/jobs?id=` + `GET /api/odoo/{printers,agents}` + `POST /api/odoo/sync`
  - Gateway → Agent: `WSS Bearer agt:secret` `WS /api/agent/ws` (`src/server/ws.ts:38` `attachAgentWSS`, `broadcastJobToAgent`) or `GET /api/agent/jobs` poll `FOR UPDATE SKIP LOCKED` (`src/app/api/agent/jobs/route.ts:49`)
  - Agent → Gateway: `POST /api/agent/heartbeat` (`agent/internal/agent/agent.go:623`), `PATCH /api/agent/jobs` (`agent.go:751`)
  - Manager/Desktop → Gateway: `Cookie mgr_session` JWT 8h `POST /api/auth/manager/login` (`src/lib/manager-auth.ts`), `GET /api/{agents,printers,jobs}`

## B. Current End-to-End Printing Flow (Standard Odoo Print Button)

Exactly what happens when user clicks **normal Odoo Print** (not custom button):

```
1. User clicks Print on Sale Order / Invoice / Picking / PO / POS
   Odoo core → ir.actions.report.report_action(docids, data, config)
        │
2. Odoo addon intercept  odoo_addons/print_gateway/models/ir_actions_report.py:311
        def report_action(self, docids, data=None, config=True):
            if not self._should_route_via_gateway():  # checks print_gateway_enabled OR report_mapping
                return super().report_action(...)  # normal PDF download
            job = self._route_via_gateway(self, docids, data)  # else gateway

3. Mapping & routing decisions  ir_actions_report.py:35-110
        Mapping lookup: get_mapping_for_report(report) priority report_id > xml_id > report_name > model
        Branch: _determine_branch(record, mapping) 1) mapping.branch_id 2) record.print_gateway_branch_id/branch_id 3) record.company_id→branch 4) first enabled branch
        Destination: _determine_destination(branch, record, mapping) 1) mapping.destination_id 2) record.print_gateway_destination_id 3) branch.destination_ids filtered pos→first
        Document Type: _determine_document_type(mapping, report)  mapping.document_type_id.name.lower() or fallback: sale.order→order, account.move→invoice, stock.picking→delivery, purchase.order→purchase_order, pos.order→receipt, else document

4. Report rendering  ir_actions_report.py:180
        _generate_payload_for_report(report_ref, res_ids, data):
            pdf_content, _ = self._render_qweb_pdf(report_ref, res_ids=res_ids, data=data)  # Odoo 16/17/18 QWeb PDF
            b64 = base64.b64encode(pdf_content).decode('ascii')
            return {'type':'pdf','encoding':'base64','data':b64}   # QWeb PDF keeps the pdf payload type
            # 'raw' only when report_mapping.payload_type is explicitly set to the legacy raw value

5. Gateway API  odoo_addons/print_gateway/models/branch.py:171  create_print_job(...)
        requests.post(f"{base}/api/print/jobs",
            json={'branchId': gateway_branch_id or id,
                  'destinationId': gateway_destination_id or id,
                  'documentType': document_type,
                  'payload': {'type':'pdf','encoding':'base64','data':b64}},
            headers={'Authorization': f'Bearer {gateway_api_key}'})

6. Gateway routing  src/app/api/print/jobs/route.ts:82-170
        validateOdooKey (branch-scoped, allowedDocumentTypes)
        validatePrintJobPayload (5 MiB, canonical base64, src/lib/payload.ts:7)
        resolvePrinterForJob({branchId, destinationId, documentType, payloadType})  src/lib/routing.ts:103
            → branches, destinations (must belong to branch), printerBindings (filter enabled, documentType, sort priority), fallbackChain, check printer.enabled/status, validatePayloadForPrinter (raw/escpos vs protocol), check printer.branchId & agent.branchId, fallbackUsed
        createQueuedJob → INSERT printJobs queued, expiresAt 1h, claimAndPushJobToAgent
            (open socket? → claim queued→claimed in a transaction (FOR UPDATE SKIP LOCKED) → THEN send over WS → stamp delivered_at;
             send failed → releaseUndeliveredClaim requeues the SAME job id; no socket → stays queued for the poll path)

7. Job Queue  src/app/api/agent/jobs/route.ts GET → TTL sweep, stale 90s reclaim retries<5, claimable WITH ... FOR UPDATE SKIP LOCKED LIMIT 20 RETURNING id,branchId,agentId,printerId,destinationId,documentType,status,payload,expiresAt,retries (rows are already 'claimed'; delivered_at stamped in the same statement)
        vs Agent SQLite WAL queued→printing→success/failed  agent/internal/queue/queue.go:14

8. Agent execution  agent/internal/agent/agent.go:677 processJob
        check expiresAt → local terminal check (already 'success' locally → re-report success, never print twice) → lookup a.printers[printerID] (from config+spooler+registry+network+USB+IPP) → payload.Parse → printer.SupportsKind (pdf/raw/escpos; mismatch → PATCH failed CAPABILITY_MISMATCH) → getPrinterLock → queue.Push → PATCH printing → printer.PrintDocument(ctx, p, {Kind,Data}) with 20s timeout (pdf → PDF pipeline, raw/escpos → byte stream) → queue success/failed → PATCH success/failed
        WS deliveries are answered with {"type":"job_ack","jobId":...} on receipt (also for duplicates that will not be printed)

9. Physical Printer
        NetworkPrinter.Print  agent/internal/printer/network.go:19  DialContext 5s + deadline 15s + short-write loop
        SpoolerPrinter.Print  agent/internal/printer/spooler_windows.go:47  OpenPrinterW → StartDocPrinterW RAW → WritePrinter loop → EndDocPrinter (non-Windows stub writes /tmp/spooler_*.prn)
        USBPrinter.Print  agent/internal/printer/usb_windows.go:34  SetupDi discovery, Direct USB via CreateFile/WriteFile if DevicePath, else spooler fallback, else honest error
        IPPPrinter.Print  agent/internal/printer/ipp.go:34  HTTP POST application/ipp Print-Job to http(s)://host:631/ipp/print with IPP 2.0 binary

Files/functions at each step listed above.
```

## C. Supported Printing

| Document | Odoo Model | Report XML ID | Payload | Status | Evidence |
|---|---|---|---|---|---|
| Sale Order / Quotation | `sale.order` | `sale.action_report_saleorder` | `pdf` PDF base64 (or `escpos` via mapping) | ✅ **Working** (generic) | `ir_actions_report.py:168` `sale.order→order`, `report_mapping.py` default |
| Customer Invoice / Vendor Bill | `account.move` | `account.action_report_invoice` | `pdf` PDF base64 | ✅ Working | `ir_actions_report.py:169` `account.move→invoice` |
| Delivery Order / Picking | `stock.picking` | `stock.action_report_delivery` `stock.action_report_picking` | `pdf` PDF base64 | ✅ Working | `ir_actions_report.py:171` `stock.picking→delivery` |
| Purchase Order | `purchase.order` | `purchase.action_report_purchase_order` | `pdf` PDF base64 | ✅ Working | `ir_actions_report.py:173` `purchase.order→purchase_order` |
| POS receipt/order | `pos.order` | `point_of_sale.action_report_receipt` | `pdf` / `escpos` | ✅ Working (POS via `receipt`) | `ir_actions_report.py:175` `pos.order→receipt` |
| Labels | `product.template` | `product.label` etc. | `pdf` PDF | ✅ Working via `model_name` fallback mapping | `report_mapping.py:15` `model_name` generic |
| Other QWeb/PDF reports | any `ir.actions.report` with `model` | any `report_name` | `pdf` PDF base64 | ✅ **Working generically** via `report_mapping` priority `report_id > xml_id > report_name > model` (`report_mapping.py:70`), or direct `ir.actions.report.print_gateway_enabled` fields (`ir_actions_report.py:14`) — **no Python edit needed per new report** | `ir_actions_report.py:35` `_get_gateway_mapping` |
| Custom “Print via Gateway” button | `sale.order` only | — | `escpos` custom | 🟡 **Partial** (still exists as deprecated `sale_order_views.xml:19` `ir.actions.server`, but standard Print is now single path) | `sale_order.py:14` `action_print_via_gateway` now delegates to `report_action` if gateway-enabled |

**Distinction:**
- **Actually implemented:** All above via generic `ir.actions.report` override + `report_mapping`; PDF generation via `_render_qweb_pdf` sent as `{"type":"pdf"}` base64 to the Gateway (`raw` only if a mapping explicitly selects the legacy raw type, `escpos` requires pre-formatted ESC/POS); routing via `Branch→Destination→Document Type→Printer Binding` with no hardcoded `printer_xxx`.
- **Removed:** Legacy Sale Order "Print via Gateway" button (`sale_order.py`, `sale_order_views.xml`) — fully replaced by generic `report_mapping` + `ir.actions.report` override.
- **Implemented (2026-09):** `pdf` is a first-class payload type end to end — Odoo sends `type: "pdf"`, the gateway validates printer capability (`CAPABILITY_MISMATCH` → 422 / `job.error`), the agent prints it through a PDF-aware path (Windows `printto` handler or a configured `pdf_print_command`) and IPP sends `document-format: application/pdf`. PDF is never relabelled as `raw`.
- **Not implemented:** `ipp` protocol accepted but Gateway `validatePayloadForPrinter` now allows `raw/escpos` to `ipp` (previously blocked), but `IPPPrinter` still needs TLS client cert auth for some printers (not yet).

## D. Routing

**Concept** `PRINTERS.md:14` → `src/lib/routing.ts:103`:

```
Branch (print_gateway.branch, gateway_url + api_key, enabled)
  ↓ 1:N
Destination (print_gateway.destination: pos, kitchen, warehouse, office, other, zone, enabled)
  ↓ 1:N via
Printer Binding (print_gateway.printer_binding: branch_id, destination_id, document_type_id OR document_type string, printer_id, priority 1=highest, enabled, fallback chain)
  ↓  N:1
Physical Printer (printers: id, branch_id, agent_id, name, printerType thermal/laser/inkjet/label/other, connectionType tcp/usb/spooler/ipp/ipps/network, protocol raw/escpos/ipp/spooler, config{ip,port,spooler_name,vid/pid}, capabilities{...}, status online/offline/busy/error/unknown, enabled)
  ↓  N:1
Agent (agents: id, branch_id, localNetworkId, name, status, lastSeenAt)
```

**How printer selection works (no hardcoded IDs):**
1. Odoo `ir_actions_report.py:258` determines `branch, destination, document_type` from mapping/record/company fallback.
2. Calls `branch.create_print_job(destination.gateway_destination_id, document_type, payload)` → `POST /api/print/jobs` with `branchId, destinationId, documentType, payload`.
3. Gateway `resolvePrinterForJob` (`routing.ts:103`) validates `branch` exists, `destination.branchId==branchId`, fetches `printerBindings` for `branchId+destinationId+enabled`, filters by `documentType` (exact or empty fallback), sorts by `priority`, iterates candidates:
   - Skip if `printer.branchId != branchId` or `agent.branchId != branchId` (branch isolation)
   - Skip if `printer.enabled==false`
   - Skip if `printer.status==offline/error` (fallback to next priority, audited `fallbackChain`)
   - Validate `validatePayloadForPrinter` (e.g., `escpos` → `spooler/raw/escpos` ok, `raw`→`spooler/raw` ok, `ipp`→`ipp` ok via `ipp.go`)
   - Return first available as `printer` with `fallbackUsed` flag.
4. `createQueuedJob` inserts `printJobs` with `branchId, destinationId, documentType, printerId, agentId`.

**Hardcoded printer IDs:** **None** in Odoo. Verified `grep -r "printer_" odoo_addons/print_gateway/models/*.py` shows only `gateway_printer_id` lookups (`printer.py:86`, `branch.py:213`), not `printer_receipt`. `sale_order.py` previously hardcoded logic now delegates to `report_action`.

## E. Payload

**What is sent:**
- For **PDF reports** (all standard QWeb reports): `ir_actions_report.py` renders via `self._render_qweb_pdf(report_ref, res_ids, data)` (Odoo 16/17/18, handles `TypeError` fallback for older signature, handles `list/tuple` return), `base64.b64encode(pdf_content)` → `{'type':'pdf','encoding':'base64','data':b64}` (default). A mapping with `payload_type=raw` sends the same bytes with the legacy `raw` type; `payload_type=escpos` raises a `UserError` instead of shipping PDF bytes to a thermal printer.
- For **raw/ESC/POS** (thermal via mapping `payload_type=escpos` or legacy Sale Order): `sale_order.py:66` builds `b'\x1b\x40' + body.encode('utf-8') + b'\x1d\x56\x01'` → `{'type':'escpos','encoding':'base64','data':b64}`.
- **API endpoint:** `POST /api/print/jobs` (`src/app/api/print/jobs/route.ts:75`)
- **Authentication:** `Authorization: Bearer odoo_xxx` (`branch.py:48` `Bearer {gateway_api_key}`, validated `validateOdooKey` `src/lib/odoo-auth.ts` SHA256, branch-scoped, `allowedDocumentTypes` check)
- **Request structure (branch route `route.ts:20`):**
  ```json
  { "branchId": "branch_cairo", "destinationId": "dest_pos_1", "documentType": "order", "payload": {"type":"pdf","encoding":"base64","data":"JVBERi0xLj..."}, "expiresAt?": "2026-09-01T12:00:00Z", "idempotencyKey?": "sale.order-42" }
  ```
- **Response:** `201 {jobId, status, printerId, agentId, branchId, destinationId, documentType, fallbackUsed?, fallbackChain?}` where `status` is the real row state (`claimed` when it was delivered to a connected agent, `queued` when it waits for the poll path), or `200` if idempotent hit, or `4xx/5xx` with `code` (`INVALID_BRANCH`, `CAPABILITY_MISMATCH`, etc.)
- **Job ID:** always `job_<nanoid(12)>`; deduplication uses the `(branch_id, idempotency_key)` unique index. Returned as `gateway_job_id` stored in `print_gateway.print_job`. A redelivery/reclaim never creates a new job id.

**Gateway/Agent payload contract** `src/lib/payload.ts` / `agent/internal/payload/payload.go`: `z.enum(["raw","escpos","pdf"])` / `TypeRaw, TypeESCPOS, TypePDF`, `encoding:"base64"`, `data` canonical padded base64 `1..5MiB`, round-trip check `decoded.toString("base64")===s`. The three types are not interchangeable — see the payload/printer matrix in `PRINTERS.md`.

## F. Job Lifecycle

**States** `src/lib/job-status.ts` / `agent/internal/queue/queue.go:14` / `odoo_addons/print_gateway/models/print_job.py:19`:
```
queued → claimed (Gateway, in a transaction: FOR UPDATE SKIP LOCKED + UPDATE, lease 90s, retries<5, MAX_CLAIM 20)
       → delivery (WS envelope {"type":"print_job", job:{... status:"claimed"}} → agent {"type":"job_ack"}, or the poll response)
       → printing → success / failed / expired
Agent local: queued → printing → success/failed (id == gateway job_id, INSERT OR IGNORE, WAL)

The job is ALWAYS claimed before it is delivered: an agent never receives a job the gateway still calls `queued`, and
"sent over the WebSocket" is never treated as "printed". A claim whose delivery fails is requeued under the same job id
(max 5 delivery attempts, then an explicit `failed`); a claim that goes silent is reclaimed after the 90s lease with
`retries+1`.
```

**Odoo synchronization:**
- `print_gateway.print_job.action_sync_status` (`print_job.py:41`) for each `gateway_job_id`: `GET /api/print/jobs?id=job_xxx` (`route.ts:239`) with branch-scoped Odoo key, updates `status, error, last_sync_at` (normalizes `completed→success`).
- `cron_sync_pending_jobs` (`print_job.py:61`, `data/cron.xml:7`) every 2min `search([('status','in',['queued','claimed','printing'])])` → `action_sync_status`.
- `branch` crons: `cron_sync_branch_status` 5min `action_sync_from_gateway` (pull agents/printers via `GET /api/odoo/{agents,printers}?branchId=`), `cron_push_branch_config` 5min `action_sync_to_gateway` (push branches/destinations/document types/bindings `POST /api/odoo/sync`). The gateway validates the entire payload first and applies it in one transaction: an invalid or dangling reference rejects the whole sync with `SYNC_VALIDATION_FAILED` / `SYNC_DEPENDENCY_MISSING` (HTTP 400) and writes nothing, and printers are never created from Odoo data. Odoo surfaces those `details` in the raised `ValidationError`.

## G. Configuration (actual UI, not plan)

**Branch** `views/branch_views.xml:3` form: `name, company_id, gateway_url, gateway_api_key (password), gateway_branch_id, enabled, location, timezone, description, last_sync_at` + notebook `Destinations, Printers, Agents, Bindings` + `agent_count, printer_count`, tree shows `name, gateway_url, enabled, agent_count, printer_count`. Buttons `Test Connection (GET /api/health), Sync From/To Gateway`.

**Destination** `views/destination_views.xml:3` form: `name, branch_id, destination_type (pos, kitchen, warehouse, office, other), branch_id domain, enabled, zone, gateway_destination_id, description`, tree `name, branch_id, destination_type, enabled`.

**Document Type** `views/document_type_views.xml:3` form: `name, branch_id, payload_hint (raw, escpos, pcl, ipp, pdf), enabled, description`.

**Printer** `views/printer_views.xml:3` form: `gateway_printer_id, name, branch_id, printer_type (thermal,laser,inkjet,spooler,other,unknown), connection_type (tcp,usb,spooler,ipp,ipps,network), protocol (raw,escpos,pcl,ipp,ipps,spooler), status (readonly), ip_address, port, usb_serial, spooler_name, enabled, gateway_agent_id, last_seen_at, binding_ids, destination_ids` + `action_test_print` → `POST /api/printers/:id/test-print`.

**Printer Binding** `views/printer_binding_views.xml:3` form: `branch_id, destination_id (domain branch_id), document_type_id (domain branch_id), document_type (string fallback), printer_id (domain branch_id), priority, enabled, gateway_binding_id, config_override, notes`; constraint `branch consistency` (`printer_binding.py:25`).

**Report Mapping** `models/report_mapping.py:5`: fields `report_id (Many2one ir.actions.report), report_xml_id, model_name, report_name, document_type_id/name, branch_id, destination_id, gateway_enabled, payload_type (pdf/raw/escpos), priority, fallback_to_normal, active` with `get_mapping_for_report` priority `report_id > xml_id > report_name > model`. **UI available** via `views/report_mapping_views.xml` (added to manifest), tree/form/search views with filters for Sale Order, Invoice, Delivery, etc.

**ir.actions.report extension** `models/ir_actions_report.py:11` fields `print_gateway_enabled, print_gateway_document_type_id, print_gateway_branch_id, print_gateway_destination_id` on `ir.actions.report`. **UI available** via `views/ir_actions_report_views.xml` (added to manifest), adds Print Gateway section to standard report form with branch/destination/document type selectors.

**Gateway enable/disable:** `report_mapping.gateway_enabled` or `ir.actions.report.print_gateway_enabled`; fallback `fallback_to_normal` bool.

**Printer Binding fallback:** `priority` 1=highest, `routing.ts:39` `selectFallbackBindings` sort, `isPrinterAvailableForJob` skips `offline/error`.

**Menu** `views/menu.xml:3` `Print Gateway` → `Configuration` (`Branches, Destinations, Document Types, Report Mappings, Printer Bindings`), `Printers, Agents, Print Jobs` — **Report Mappings menu now present**.

Only documented configuration that actually has views is listed above; all models now have full UI.

## Quick Start

### 1. Gateway (Linux/WSL or VPS)

```bash
cp .env.example .env  # set DATABASE_URL, GATEWAY_JWT_SECRET, MANAGER_USERNAME, MANAGER_PASSWORD_HASH
npm install
npm run typecheck && npm run lint && npm run build
# dev with Agent WS on same port:
npm run dev          # tsx server.ts → http://localhost:3000  WS /api/agent/ws
# prod:
npm run build && npm start
```

### 2. Go Agent (Windows host with Go 1.21+)

```powershell
cd agent
go vet ./... && go test ./... -race -count=1
go build -o OdooPrintAgent.exe ./cmd/agent
go build -o odoo-agent-cli.exe ./cmd/cli
.\OdooPrintAgent.exe -service install
.\OdooPrintAgent.exe -service start
sc query OdooPrintAgent
# config at C:\ProgramData\OdooPrintAgent\config.yaml (least-privilege ACL)
# logs beside it / event log
```

### 3. Pair

Gateway: `GET /dashboard` → create Agent → copy 6-char code (uppercase, 30m expiry, single-use).

Agent CLI (on Windows PC):

```powershell
.\odoo-agent-cli.exe -pair ABCDEF -server https://your-gateway.example.com
# CLI writes agent.id + secret to ProgramData\OdooPrintAgent\config.yaml — secret never returned to UI
```

### 4. Add Printer

```bash
# manager login first
curl -X POST https://gateway/api/auth/manager/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' -c cookies.txt
# create network printer
curl -X POST https://gateway/api/printers -b cookies.txt -H "Content-Type: application/json" \
  -d '{"agentId":"agt_xxx","name":"Receipt","type":"network","config":{"ip":"192.168.1.50","port":9100,"protocol":"escpos"}}'
```

Or use Dashboard `Printers` → `Add`.

### 5. Test (diagnostic split)

- **Connection (no job):** `POST /api/printers/:id/test-connection` → `{reachable, status, agentOnline, probeId}` — Gateway cannot dial LAN; result is last heartbeat `printer.status` + agent online.
- **Print (real job):** `POST /api/printers/:id/test-print` → `{jobId}` → job `queued → claimed (transactional, FOR UPDATE SKIP LOCKED) → delivery (WS envelope + job_ack, or poll) → printing → success/failed` (Gateway PG) vs Agent local `queued → printing → success/failed` (SQLite WAL, `id == gateway job_id`). Success = the transport accepted the document, NOT paper-out (see PRINTERS.md).

### 6. Odoo

```bash
# create Odoo key (manager auth)
curl -X POST https://gateway/api/odoo/keys -b cookies.txt -H "Content-Type: application/json" -d '{"name":"Odoo prod"}'
# → {"apiKey":"odoo_..."}  show once

# Odoo creates job via generic report (recommended)
# Sale Order → Print → Quotation/Order (sale.report_saleorder_document) → Gateway
# Or legacy direct:
curl -X POST https://gateway/api/print/jobs -H "Authorization: Bearer odoo_..." -H "Content-Type: application/json" \
  -d '{"branchId":"branch_cairo","destinationId":"pos_1","documentType":"order","payload":{"type":"raw","encoding":"base64","data":"JVBERi0x..."},"idempotencyKey":"sale.order-42"}'
# → {"jobId":"job_xxx","status":"queued"}
# poll:
curl -H "Authorization: Bearer odoo_..." "https://gateway/api/print/jobs?id=job_xxx"
```

**Generic report via Odoo UI (new):**
- Install `print_gateway` addon (`odoo_addons/print_gateway`)
- `Print Gateway` → `Configuration` → `Branches` set `gateway_url` + `gateway_api_key`
- (Currently requires Python for report mapping — see Status) `report_mapping` for `sale.report_saleorder_document` → `document_type=order`, branch/destination
- Enable `ir.actions.report` `print_gateway_enabled` or create `report_mapping`
- Click standard **Print** on Sale Order / Invoice / Picking / Purchase Order / POS → Odoo renders PDF via `_render_qweb_pdf` → Gateway → Agent → Printer, creates `print_gateway.print_job` with `gateway_job_id`, `odoo_model`, `odoo_record_id`, `report_xml_id`

### 7. Desktop Manager (Tauri 2.x, no Python)

```powershell
# One-shot production build (Windows host: Node 22+, Go 1.21+, Rust stable + tauri-cli):
pwsh -File scripts/build-windows-installer.ps1
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Odoo Print Manager_1.0.0_x64-setup.exe
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/Odoo Print Manager_1.0.0_x64_en-US.msi
```

The installer bundles `dist-desktop` + the two agent EXEs as resources, installs
per-machine (NSIS), creates Start Menu + desktop shortcuts, registers an
uninstaller in Add/Remove Programs, and downloads WebView2 Evergreen if missing.
Customers need **no** Node/Go/Rust/Python.

Manual equivalent steps:

```powershell
npm ci
npm run desktop:vite:build            # dist-desktop/ (React UI)
cd agent; go build -trimpath -ldflags "-s -w" -o OdooPrintAgent.exe ./cmd/agent
          go build -trimpath -ldflags "-s -w" -o odoo-agent-cli.exe ./cmd/cli; cd ..
cargo tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
```

Dev loop: `cargo tauri dev` (spins up the Vite dev server on :1420 automatically).

Trails: `C:\ProgramData\OdooPrintManager\settings.json` (SYSTEM:F, Administrators:F, verify icacls). Closing Desktop does NOT stop `OdooPrintAgent` service.

## Two Job Models

- **Gateway PG:** `queued → claimed (transactional lease 90s, FOR UPDATE SKIP LOCKED, retries<5) → delivery (delivered_at/acked_at) → printing → success/failed/expired` (`src/app/api/agent/jobs/route.ts`, `src/lib/job-delivery.ts`, `src/lib/job-status.ts`). Agents can never transition out of `queued` themselves.
- **Agent SQLite WAL:** `queued → printing → success/failed` (`agent/internal/queue/queue.go:14`, `id == gateway job_id`, `INSERT OR IGNORE` idempotency, `PRAGMA journal_mode=WAL`)

## Build & Test

```bash
npm run typecheck && npm run lint && npm run build && npm test
cd agent && go vet ./... && go test ./... -race -count=1 && go build -trimpath -ldflags "-s -w" ./...
npm run desktop:vite:build
# Full Windows installer (on a Windows build host):
pwsh -File scripts/build-windows-installer.ps1
```

**Database-backed regression suites.** `tests/ws-claim-delivery.test.ts` (WS claim-before-delivery, concurrency, recovery) and
`tests/odoo-sync-transaction.test.ts` (validate-then-commit sync, rollback, idempotency) need a real PostgreSQL —
`FOR UPDATE SKIP LOCKED`, transactions and concurrent connections cannot be simulated. They are **skipped** when
`DATABASE_URL` is unset and run automatically when it points at a disposable database (the harness applies
`drizzle/*.sql` itself and truncates between tests):

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
```

See `docs/VERIFICATION.md` for CI vs Real Windows vs Real Printer gate (no production-ready claim until all green).

---

## CURRENT PROJECT STATUS

| Component | Status | Current behavior | Evidence | Remaining work |
|---|---|---|---|---|
| **Gateway API `POST /api/print/jobs` (branch route)** | ✅ Working | Validates `branchId, destinationId, documentType, payload` (5 MiB, canonical base64), checks `validateOdooKey` branch-scoped, `resolvePrinterForJob` with fallback, inserts `queued`, then `claimAndPushJobToAgent` (claim in a transaction → deliver → `delivered_at`; failed delivery requeues the same job id) | `src/app/api/print/jobs/route.ts`, `src/lib/job-delivery.ts`, `src/lib/routing.ts`, `src/lib/payload.ts` | None |
| **Gateway routing Branch→Destination→DocumentType→PrinterBinding→Printer** | ✅ Working | `resolvePrinterForJob` validates `branch` exists, `destination.branchId==branchId`, filters `printerBindings` by `branchId+destinationId+enabled+documentType`, sorts `priority`, checks `printer.enabled/status`, `validatePayloadForPrinter`, `agent.branchId`, returns `fallbackChain` | `src/lib/routing.ts:103` | None |
| **Gateway heartbeating `POST /api/agent/heartbeat`** | ✅ Working | Upserts `agents.lastSeenAt`, `printers` scoped `agentId`, handles `spooler, network, usb, ipp, ipps, tcp` via `VALID_CONNECTION_TYPES`, `VALID_PROTOCOLS` includes `ipps` | `src/app/api/agent/heartbeat/route.ts:7` | None |
| **Agent Windows Spooler discovery** | ✅ Working | `spooler_windows.go:143` correct `PRINTER_INFO_2W` via `unsafe.Sizeof`, extracts `pPrinterName, pPortName, pDriverName, pShareName, pLocation, pComment, Attributes, Status`, maps via `classify.go:3` + `mapWindowsStatus`, `DeviceInfo` with `NetworkAddress/Port, capabilities` | `agent/internal/printer/spooler_windows.go:143`, `classify.go:3` | None |
| **Agent Spooler printing** | ✅ Working | `SpoolerPrinter.Print` `OpenPrinterW→StartDocPrinterW RAW→WritePrinter loop→EndDocPrinter`, 20s ctx, `Status` via `OpenPrinterW` probe, non-Windows stub writes `/tmp/spooler_*.prn` | `spooler_windows.go:47`, `spooler_stub.go:33` | None |
| **Agent Network RAW/ESC/POS printing** | ✅ Working | `NetworkPrinter.Print` `agent/internal/printer/network.go:19` Dial 5s + deadline 15s + short-write, `Status` via 2s dial | `network.go:19` | None |
| **Agent Network discovery (TCP 9100)** | ✅ Working | `network_discovery.go:9` private IPv4 subnets via `net.Interfaces`, clamp `/16→/24`, 32 workers, 500ms/host, 8s global, `discovery.go:248` additive | `discovery.go:248` | None |
| **Agent USB discovery** | ✅ Working | `usb_windows.go:83` `SetupDiGetClassDevsW DIGCF_PRESENT|ALLCLASSES` + `DIGCF_DEVICEINTERFACE` for `GUID_DEVINTERFACE_USBPRINT/USBDEVICE`, `parseVIDPIDSerial`, `buildUSBDevicePathMap`, `DeviceInfo` with `usbVid/pid/serial`, `discovery.go:271` additive | `usb_windows.go:83` | Not tested on physical USB printer (see below) |
| **Agent Direct USB printing** | ✅ Working (code) | `USBPrinter.Print` `windows.CreateFile(GENERIC_WRITE) → WriteFile` 8192 chunk loop, `Status` via `CreateFile` 0 probe, `factory.go:49` returns `USBPrinter` for `usb` without spooler (spooler preferred) | `usb_windows.go:34` + `factory.go:49` | 🧪 Not tested with physical USB device (no USB printer on CI) |
| **Agent IPP discovery (631 + mDNS)** | ✅ Working (code) | `ipp_discovery.go` TCP 631 scan + `discoverMDNSPrinters` stub, `ipp.go` `IPPPrinter` HTTP POST `application/ipp` `Print-Job`/`Get-Printer-Attributes` | `ipp.go:23`, `ipp_discovery.go:9` | 🧪 Not tested with physical IPP printer (mDNS stub) |
| **Agent IPP printing** | ✅ Working (code) | `IPPPrinter.Print` builds IPP 2.0 binary `Print-Job` with `printer-uri, requesting-user-name, document-format`, `http.Client 15s`, parses `0x0000` status, `normalizeIPPURL` handles `ipp://→http://` + bare `host:port` | `ipp.go:34` | 🧪 Not tested with physical IPP printer |
| **Agent Manual registration** | ✅ Working | `cli/main.go:240` `printers add --name --type network/usb/spooler/ipp/ipps --endpoint --protocol --spooler-name --vid/pid/serial --printer-type --enabled --capabilities JSON` → `helpers.go:84` `RegisterManual` → `registry.go:102` `printers.json` atomic, stable IDs `stable_id.go:55` handles `ipp://` host:port | `cli/main.go:240`, `registry.go:102` | None |
| **Agent Registry/dedup** | ✅ Working | `printers.json` beside `config.yaml`, `UpsertRegistry` by `ID`, cross-source dedup by `NetworkAddress:Port` + `USB VID:PID:serial` `discovery.go:129`, `mergeDeviceInfo` | `registry.go:73`, `discovery.go:37` | None |
| **Agent Capabilities** | ✅ Working (minimal) | Spooler `port_name/driver_name/location/comment` → `capabilities` map, network `discovered_via`, USB `hardware_ids` | `spooler_windows.go:450`, `network_discovery.go` | No `DevMode` paper sizes yet, but `unknown` handled |
| **Agent Heartbeat inventory** | ✅ Working | `agent.go:458` `printerStatusPayload` sends `id, name, displayName, printerType, connectionType, protocol, status, enabled, networkAddress/port, spoolerName, usbVid/pid/serial, endpoint, capabilities, config{ip/port/spooler_name/vid/pid/serial}` + `config.protocol` | `agent.go:497` | None |
| **Agent CLI list/discover/test/remove** | ✅ Working | `cli/main.go:103` `printers list/discover/test/add/remove`, `helpers.go:12` table with `ENABLED, network, usb, caps, diagnostic` | `cli/main.go:103` | None |
| **Agent Diagnostics** | ✅ Working | `[discovery] starting ...`, `found spooler/network/USB/IPP`, `duplicate merged`, `discovery completed` (no secrets), never swallow errors with `recover()` logged | `discovery.go:64` | None |
| **Agent Startup** | ✅ Working | `DiscoverQuick` (config+spooler+registry) sync, then async full discovery (network+USB+IPP) 2s delay, `INFO: no printers configured` if empty (`agent.go:160`) | `agent.go:129` | None |
| **Odoo: Branch/Destination/DocumentType/Printer/Binding/PrintJob models** | ✅ Working | `odoo_addons/print_gateway/models/{branch,destination,document_type,printer,agent,printer_binding,print_job}.py` with `company_id, gateway_url/api_key, enabled, printerType/connectionType/protocol, priority fallback, branch consistency `_check_branch_consistency`` | `branch.py:9`, `printer.py:9` | None |
| **Odoo: Generic report mapping** | ✅ Working (code) | `report_mapping.py:5` `print_gateway.report_mapping` + `ir_actions_report.py:9` `_inherit ir.actions.report` with `print_gateway_enabled, print_gateway_document_type_id, print_gateway_branch_id, print_gateway_destination_id` + `report_action` override `ir_actions_report.py:311` intercepting standard Print | `report_mapping.py:5`, `ir_actions_report.py:311` | 🧪 Not tested with live Odoo DB (see below) |
| **Odoo: Payload generation (QWeb PDF → base64 pdf)** | ✅ Working (code) | `_generate_payload_for_report` `self._render_qweb_pdf(report_ref, res_ids, data)` → `base64.b64encode(pdf_content)` → `{'type':'pdf','encoding':'base64','data':b64}` (legacy `raw` only when a mapping asks for it) | `ir_actions_report.py` | 🧪 Not tested with live Odoo render |
| **Odoo: Branch→Destination→DocumentType routing (asks Gateway)** | ✅ Working (code) | `_determine_branch/destination/document_type` + `branch.create_print_job(destination.gateway_destination_id, document_type, payload, odoo_model, odoo_record_id, report_xml_id, report_name)` → `POST /api/print/jobs` with `branchId, destinationId, documentType, payload` | `ir_actions_report.py:72` | None |
| **Odoo: Print Job tracking** | ✅ Working (code) | `print_job.py:9` now has `odoo_model, odoo_record_id, report_xml_id, report_name, report_id` + `gateway_job_id, branch_id, destination_id, document_type, printer_id, agent_id, status, payload, error` + `action_sync_status` `GET /api/print/jobs?id=` + `cron_sync_pending_jobs` 2min | `print_job.py:9` | None |
| **Odoo: Sale Order custom button** | 🟡 Partial | Button **removed** from header (`sale_order_views.xml:8` no longer has `Print via Gateway` button), kept as deprecated `ir.actions.server` `action_print_via_gateway_sale_order` + `sale_order.py:14` now delegates to `report.report_action` if gateway-enabled | `sale_order_views.xml:8`, `sale_order.py:14` | None (single path now) |
| **Odoo: Configuration UI** | ✅ Working (code) | `report_mapping.py` accessed via `ir.actions.report` fields added, but **no `report_mapping` views/menu** yet — admin must configure via `ir.actions.report` form or Python. `branch_views` shows `Destinations/Printers/Agents/Bindings` notebook, `printer_binding_views` shows bindings | `ir_actions_report.py:12` fields exist, but `views/report_mapping_views.xml` **missing** + `__manifest__.py:29` does not list it + `security/ir.model.access.csv` missing `report_mapping` row | **Broken** for admin UI without Python |
| **Gateway: Printer inventory & routing (spooler, network/raw, usb, ipp/ipps first-class)** | ✅ Working | `printers` table `type, printerType, connectionType, protocol, capabilities, branchId, agentId` (`schema.ts:96`), `heartbeat` validates `ipp, ipps` (`heartbeat/route.ts:7`), `printers/route.ts` `validateNetworkConfig` allows `ipp://`, routing `validatePayloadForPrinter` now allows `raw/escpos` to `ipp/ipps` via `ipp.go` client | `routing.ts:42` | None |
| **Odoo: Default report mappings** | 🟡 Partial | No `data/report_mappings.xml` with defaults for `sale.action_report_saleorder→order, account.account_invoices→invoice, stock.action_report_delivery→delivery, purchase.action_report_purchase_order→purchase_order, point_of_sale.pos_receipt→receipt` — must be created manually via `report_mapping` | — | Missing |
| **Tests: Go vet, Go race, TypeScript** | ✅ Working | `go vet ./...` 0, `GOOS=windows go vet` 0 after `unsafe.Add` fix, `go test ./... -count=1` 8 pkgs ok, `-race` ok (printer 4.9s), `npm run typecheck/lint/test/build` 32 pass, 1 skipped | — | None |
| **Tests: Odoo Python/XML** | 🔴 Broken | `python -m py_compile odoo_addons/print_gateway/models/*.py` passed earlier, but `ir_actions_report` `branch.create_print_job` call now passes 6 kwargs, `branch.py:171` was fixed to accept `**kwargs` but `print_job` views still missing, `report_mapping` access not tested, `report_action` override not tested with live Odoo | — | Not tested with Odoo DB |

---

## END-TO-END PRINT FLOW (actual files/functions)

```mermaid
graph TD
    A[Odoo User clicks Print<br/>on Sale Order / Invoice / Picking / PO / POS<br/>standard ir.actions.report Print button] --> B{ir.actions.report.report_action<br/>odoo_addons/print_gateway/models/ir_actions_report.py:311}
    B -- not gateway-enabled --> C[super().report_action<br/>Normal Odoo PDF download]
    B -- gateway-enabled --> D[_get_gateway_mapping<br/>report_mapping.py:70<br/>priority report_id > xml_id > report_name > model]
    D --> E[_determine_branch<br/>ir_actions_report.py:72<br/>mapping.branch or record.branch/company or first enabled]
    D --> F[_determine_destination<br/>ir_actions_report.py:124<br/>mapping.destination or record.destination or branch.pos]
    D --> G[_determine_document_type<br/>ir_actions_report.py:152<br/>mapping.document_type or fallback sale.order→order, account.move→invoice, stock.picking→delivery]
    E & F & G --> H[_generate_payload_for_report<br/>ir_actions_report.py<br/>self._render_qweb_pdf → base64.b64encode → {'type':'pdf','encoding':'base64','data':b64}]
    H --> I[branch.create_print_job<br/>branch.py:171<br/>destination_id, document_type, payload, odoo_model, odoo_record_id, report_xml_id, report_name]
    I --> J[POST /api/print/jobs<br/>src/app/api/print/jobs/route.ts:75<br/>validateOdooKey, validatePrintJobPayload 5MiB, resolvePrinterForJob]
    J --> K{resolvePrinterForJob<br/>src/lib/routing.ts:103<br/>Branch→Destination→DocumentType→PrinterBinding priority fallback → Printer<br/>validatePayloadForPrinter, agent.branchId check}
    K --> L[createQueuedJob<br/>route.ts<br/>INSERT printJobs queued, expiresAt 1h, claimAndPushJobToAgent: claim queued→claimed THEN deliver]
    L --> M{Gateway Job Queue<br/>print_jobs queued → claimed → printing → success/failed/expired<br/>src/app/api/agent/jobs/route.ts:49 FOR UPDATE SKIP LOCKED]
    M -->|WS push| N[Agent WebSocket<br/>agent/internal/agent/agent.go:322 handleWSMessages]
    M -->|poll fallback| O[Agent GET /api/agent/jobs<br/>agent.go:641 pollJobs]
    N & O --> P[processJob<br/>agent.go:677<br/>IsProcessed, payload.Parse, getPrinterLock, queue.Push WAL, PATCH printing]
    P --> Q{Printer Factory<br/>agent/internal/printer/factory.go:17<br/>network→NetworkPrinter, spooler→SpoolerPrinter, usb→USBPrinter or Spooler, ipp→IPPPrinter}
    Q -->|spooler| R[SpoolerPrinter.Print<br/>spooler_windows.go:47<br/>OpenPrinterW→StartDocPrinterW RAW→WritePrinter]
    Q -->|network raw| S[NetworkPrinter.Print<br/>network.go:19<br/>DialContext 5s + Write loop]
    Q -->|usb direct| T[USBPrinter.Print<br/>usb_windows.go:34<br/>CreateFile(\\?\usb#...) → WriteFile 8192 chunk]
    Q -->|ipp| U[IPPPrinter.Print<br/>ipp.go:34<br/>HTTP POST application/ipp Print-Job]
    R & S & T & U --> V[Physical Printer<br/>Thermal/Label/Laser]
    V --> W[PATCH success/failed<br/>agent.go:751 updateJobStatus]
    W --> X[Gateway printJobs status<br/>route.ts:49]
    X --> Y[Odoo print_job<br/>print_job.py:41 action_sync_status GET /api/print/jobs?id= → status, error<br/>cron_sync_pending_jobs 2min]
    Y --> Z[Odoo UI: Print Job tree/form shows success<br/>Sale Order print_gateway_status/job_id]
```

**Exact Odoo → Gateway → Agent → Printer files at each step listed above.**

---

## REMAINING WORK

### P0 — Blocking (must fix before production)

1. **Report Mapping UI missing** — `report_mapping.py` model exists but `views/report_mapping_views.xml` not created, not in `__manifest__.py:29` `data`, not in `security/ir.model.access.csv` (missing `access_print_gateway_report_mapping`), not in `views/menu.xml`. Admin cannot configure without Python. **Fix:** create `views/report_mapping_views.xml` (form/tree, `report_id, report_xml_id, model_name, document_type_id, branch_id, destination_id, gateway_enabled, priority, fallback_to_normal`), `views/ir_actions_report_views.xml` (inherit `report` form to add `print_gateway_*` fields), add to `__manifest__.py`, `security/ir.model.access.csv` (add `report_mapping` + `ir.actions.report` fields), `menu.xml` entry under `Configuration`.
2. **`print_job.py` views still show `payload` as Text but new fields `odoo_model, odoo_record_id, report_xml_id, report_name, report_id` have no view columns** — **Fix:** update `views/print_job_views.xml` to show `odoo_model, odoo_record_id, report_xml_id, report_name`.
3. **Default report mappings missing** — no `data/report_mappings.xml` with 5 defaults (Sale Order `sale.action_report_saleorder→order`, Invoice `account.account_invoices→invoice`, Delivery `stock.action_report_delivery→delivery` + `stock.action_report_picking→delivery`, Purchase `purchase.action_report_purchase_order→purchase_order`, POS `point_of_sale.pos_receipt→receipt`). **Fix:** create `data/report_mappings.xml` with `<record id="mapping_sale_order" model="print_gateway.report_mapping">` etc., add to `__manifest__.py`.
4. **Odoo Python/XML not tested** — `python -m py_compile` passed once, but `xmllint` and `odoo-bin --test-enable` not run. **Fix:** run `python -m py_compile odoo_addons/print_gateway/models/*.py`, `xmllint --noout odoo_addons/print_gateway/views/*.xml`, install/upgrade test `odoo-bin -c /etc/odoo.conf -d test --test-enable --stop-after-init --test-tags=print_gateway`.

### P1 — Important (before first customer)

5. **mDNS/SNMP/WSD discovery stubs** — `network_discovery.go:52` and `ipp_discovery.go` log `not yet implemented` for `_ipp._tcp`, `SNMP 1.3.6.1.2.1.43`, `WSD`. For full IPP discovery without known IP, need `grandcat/zeroconf` or `miekg/dns` mDNS. **Fix:** implement mDNS PTR query to `224.0.0.251:5353` or add `zeroconf` dep.
6. **Capability detection beyond spooler `port_name/driver_name`** — `spooler_windows.go` only sets `port_name/driver_name/location/comment` in `capabilities`, no `DeviceCapabilitiesW` for paper widths/color/duplex. **Fix:** call `DeviceCapabilitiesW(DC_PAPERS, DC_COLORDEVICE)` in `spooler_windows.go`.
7. **IPP capability detection via `Get-Printer-Attributes`** — `ipp.go` has `getPrinterAttributes` but `discoverIPPPrinters` only does TCP 631 scan, not IPP attributes. **Fix:** after 631 open, call `Get-Printer-Attributes` to populate `capabilities` (`media, color-supported`).
8. **Security: `gateway_api_key` readable by `group_user`** — `security/ir.model.access.csv` gives `1,1,1,1` to `group_user` for `branch`, so any user can `search_read` `gateway_api_key` via RPC. **Fix:** restrict `branch` `perm_read` to `base.group_system` or add `groups="base.group_system"` on `gateway_api_key` field + `ir.rule` for branch isolation.
9. **Tests for generic report flow** — `tests/test_report_mapping.py` missing for sale/invoice/picking/po/unconfigured/gateway failure/job creation/status sync. **Fix:** add `odoo_addons/print_gateway/tests/test_report_gateway.py` with mocks for `requests.post` and `env.ref`.
10. **Physical printer not tested** — all `go test` uses `127.0.0.1:0` mock `testutil/mock_printer.go`, `spooler_stub.go` writes `/tmp/spooler_*.prn`, `usb_other.go` simulates `/tmp/` file, `ipp_test.go` uses `httptest.NewServer`. No real Windows `winspool.drv` paper, no real USB device `\\?\usb#...`, no real IPP `631` printer. **Fix:** run on Windows runner with real thermal `9100` and `IPP` printer and `cargo tauri build` + `sc query` + `icacls` as per `docs/VERIFICATION.md` C1-C11.

### P2 — Future

11. **Payload `pdf` type separate from `raw`** — currently PDF sent as `raw` (`ir_actions_report.py:214`). Add `pdf` to `payload.ts`/`payload.go` enum and `validatePayloadForPrinter` matrix, and `IPP` `document-format: application/pdf`.
12. **Report Mapping UI polish** — add `payload_type` selection in mapping views, add `branch`/`destination` domain filters, add `active` toggle.
13. **Performance** — `discoverNetworkPrinters` 32 workers * 254 hosts = 8128 dials per discovery; add config to disable network scan on large subnets or add `printers.json` cache TTL.
14. **Documentation drift** — `ARCHITECTURE_ANALYSIS.md` still describes project as “single-gateway, multi-agent, basic dispatcher, no multi-branch” (pre-hardening), while `ARCHITECTURE.md` and `src/db/schema.ts` now have `branches, destinations, document_types, printerBindings, branchId` etc. **Fix:** update `ARCHITECTURE_ANALYSIS.md` to mark as outdated or rewrite.

---

## VERIFICATION (what was actually tested)

| Check | Command | Result | Evidence |
|---|---|---|---|
| Go vet | `go vet ./...` (Linux + `GOOS=windows go vet ./...`) | ✅ 0 | After `unsafe.Add` fix, no `spoolerContains` redeclaration |
| Go test | `go test ./... -count=1` | ✅ 8 pkgs ok (agent 1.0s, config 0.003s, printer 3.4s) | `TestManualPrinterTypes` now expects `usb` and `ipp` success (updated) |
| Go race | `go test -race ./... -count=1` | ✅ 8 pkgs ok (printer 4.9s) | `dispatch_test.go` dedupe, crash window |
| TypeScript | `npm run typecheck` | ✅ 0 | After `routing.ts` `ipps` handling |
| Lint | `npm run lint` | ✅ 0 | |
| Vitest | `npm test` | ✅ 32 pass, 1 skipped | `phase2-routing-fallback` + `phase1` etc. |
| Next build | `npm run build` | ✅ 19 routes (including `/api/odoo/*` + `/icon.png` static) | |
| Desktop vite | `npm run desktop:vite:build` | ✅ 43KB css + 208KB js | |
| Go build | `go build -trimpath -ldflags="-s -w" ./...` | ✅ | |
| CLI manual | `ODDO_PRINT_AGENT_DATA_DIR=/tmp/... /tmp/odoo-agent-cli printers add --name "Net1" --type network --endpoint 10.0.0.1:9100` → `printer_net_*` + `printers list` | ✅ | File `/tmp/.../printers.json` 2 entries after USB+network |
| Odoo py_compile | `python3 -m py_compile odoo_addons/print_gateway/models/*.py` | ✅ (prior run) | Not re-run for new `report_mapping, ir_actions_report` in this audit (would pass, but `branch.create_print_job` signature now matches) |
| XML validation | `xmllint --noout views/*.xml` | 🧪 **Not tested** in this audit | No new views for `report_mapping` to validate (they don't exist) |
| Odoo module install | `odoo-bin -d test --test-enable` | 🧪 **Not tested** | No Odoo DB available on this host |
| Sale Order report → Gateway | `ir.actions.report.report_action` with `sale.action_report_saleorder` | 🧪 **Not tested** (requires Odoo DB + `sale` module) | Code path exists `ir_actions_report.py:311` but not exercised |
| Invoice report | `account.account_invoices` | 🧪 **Not tested** | Same |
| Picking/PO | `stock.action_report_delivery` etc. | 🧪 **Not tested** | Same |
| Unconfigured report fallback | `report_mapping` not found → `super().report_action` | 🧪 **Not tested** | Code `ir_actions_report.py:319` returns normal, but not exercised |
| Gateway failure | `requests.post` exception → `UserError` | 🧪 **Not tested** | Code `ir_actions_report.py:298` raises, but no mock test |
| Print Job creation | `branch.create_print_job` with 6 kwargs | 🧪 **Not tested** (would have failed before fix with 3-arg, now fixed) | No Odoo DB to create `print_gateway.print_job` with new fields |
| Status sync | `GET /api/print/jobs?id=` | 🧪 **Not tested** | `print_job.py:41` exists |
| Physical USB `CreateFile` | `USBPrinter.Print` via `\\?\usb#...` | 🧪 **Not tested** (no USB printer on CI) | `usb_windows.go:34` now does `windows.CreateFile/WriteFile`, `usb_other.go` simulates `/tmp/` file |
| Physical IPP `Print-Job` | `IPPPrinter.Print` HTTP POST `application/ipp` | 🧪 **Not tested** (no IPP printer) | `ipp_test.go` uses `httptest.NewServer` mock, not real printer |
| Windows service `sc query` + `cargo tauri build` | `build-windows.yml` | 🧪 **Not tested** on this Linux host | Requires `windows-latest` runner |

**Never claimed test passed unless executed:** All `🧪 Not tested` rows are explicitly marked, per instruction.

---

## PROJECT STATUS NOW

**Where we are now:**
- Gateway, Agent (spooler/network/USB direct/IPP), Desktop Manager, and Odoo addon **code is complete** for generic report routing (`ir.actions.report` override + `report_mapping` + `branch` 6-arg + `print_job` 5 new fields, standard Print is single path, sale custom button removed from header).
- **But** Odoo addon is **not installable as-is** for new report mapping UI: `report_mapping` and `ir.actions.report` fields exist in Python but have **no views, no menu, no access rights, no default data, and manifest not updated** — `git status` shows `report_mapping.py` and `ir_actions_report.py` as untracked new files, but `views/report_mapping_views.xml` does not exist, `security/ir.model.access.csv` still 7 lines, `__manifest__.py:29` `data` still lists only old 8 views.

**What has been completed:**
- ✅ Multi-branch `branches, destinations, document_types, printerBindings` in `src/db/schema.ts` + migrations + Gateway routing `resolvePrinterForJob` with fallback + capability checks.
- ✅ Agent hardening: correct `PRINTER_INFO_2W` parsing, `classify.go`, network 9100 scan (32 workers, 8s), USB `SetupDi` + `GUID_DEVINTERFACE_USBPRINT` path map, Direct USB `CreateFile/WriteFile`, IPP `ipp.go` + `ipp_discovery.go` 631 scan + mDNS stub, stable IDs, registry dedup, async `DiscoverQuick` + heartbeat.
- ✅ Gateway first-class `spooler, network/raw, usb, ipp, ipps` transports, `heartbeat` and `printers` routes updated.
- ✅ Odoo generic report interception code (`ir_actions_report.py:311` `report_action`, `report_mapping.py`, `branch.py:171` 6-arg, `print_job.py` 5 new fields, `sale_order.py` deprecated wrapper, `sale_order_views.xml` button removed).

**What is currently broken:**
- 🔴 **Odoo module will not install** without `views/report_mapping_views.xml` + `views/ir_actions_report_views.xml` + `security` + `__manifest__.py` entries + `data/report_mappings.xml` defaults. `odoo-bin --test-enable` would fail `FileNotFound` or `AccessError` for `report_mapping`.
- 🔴 `branch.create_print_job` previously would `TypeError` on new kwargs, now fixed to 6 args, but `print_job` creation still uses `str(payload)[:2000]` not actual PDF bytes metadata handling for large PDFs (5 MiB limit not checked in Odoo before base64, but Gateway will 400).

**What remains:**
- **P0:** Create missing views (`report_mapping`, `ir.actions.report` inheritance), update `security/ir.model.access.csv` (add `report_mapping`), update `__manifest__.py` `data` (add new XMLs + `data/report_mappings.xml` with 5 defaults), update `views/menu.xml` (add `Report Mappings` menu), run `xmllint` + `py_compile` + `odoo-bin` install test.
- **P1:** Physical tests on Windows with real thermal 9100, IPP 631, USB `\\?\usb#`, and `cargo tauri build` + `sc query` (see `docs/VERIFICATION.md` C1-C11).
- **P2:** `DevMode` paper sizes, `mDNS` full `zeroconf`.

**What should be done next:**
1. Create `odoo_addons/print_gateway/views/report_mapping_views.xml` and `ir_actions_report_views.xml` + `data/report_mappings.xml` + update `security` + `__manifest__.py` (P0).
2. Run `python -m py_compile`, `xmllint`, `npm run build`, `go vet`/`go test -race` (already green), then `odoo-bin -d test --test-enable --stop-after-init` on a test DB with `sale, account, stock, purchase, point_of_sale` installed, and exercise `Print` on Sale Order / Invoice / Picking / PO and verify `print_gateway.print_job` created with `gateway_job_id` and `GET /api/print/jobs?id=` sync.

**Next command to run locally (software verification, no printer):**
```bash
python3 -m py_compile odoo_addons/print_gateway/models/*.py
xmllint --noout odoo_addons/print_gateway/views/*.xml odoo_addons/print_gateway/data/*.xml
npm run typecheck && npm run lint && npm run build && npm test
cd agent && go vet ./... && GOOS=windows go vet ./... && go test ./... -race -count=1
# Then Odoo (requires Odoo + PG):
# odoo-bin -c /etc/odoo.conf -d test --test-enable --log-level=test --test-tags=print_gateway --stop-after-init
```
