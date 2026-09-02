# Windows physical end-to-end verification

**Status: NOT VERIFIED — physical printer test unavailable in this repository's CI.**
This document is the exact manual procedure required to close that gap. Do **not** mark it
as completed, and do not claim physical printing works, unless a real Windows machine with a
real printer was used and the result table at the end was filled in from that run.

Everything the automated suites do and do not cover is listed in [docs/TESTING.md](docs/TESTING.md).

---

## 0. Prerequisites

| Item | Requirement |
|---|---|
| OS | Windows 10 1809+ or Windows 11 (x64), administrator account |
| Printer | At least one real printer, installed as a Windows printer (spooler queue) and printing correctly from Notepad |
| PDF handler | A PDF application registered for the `printto` verb (Adobe Reader, SumatraPDF …) **or** a helper configured through `agent.pdf_print_command` |
| Second printer (optional but recommended) | A RAW/ESC-POS thermal printer on TCP :9100 for the capability-mismatch test |
| Gateway | Reachable over HTTPS from the Windows PC, with a PostgreSQL database migrated through `drizzle/0005_auth_rate_limits.sql` |
| Odoo | A live instance with the `print_gateway` addon installed |
| Artifacts | `Odoo Print Manager` MSI or NSIS EXE from the `Build Windows Installer` workflow (or a local `cargo tauri build`) |

Record the environment before starting: Windows build, gateway URL/version, Odoo version,
printer make/model and driver, PDF handler and version.

---

## 1. Install

1. Copy the MSI (or NSIS EXE) to the Windows PC.
2. Install per-machine (`msiexec /i "Odoo Print Manager_<version>_x64_en-US.msi"`).
3. Confirm `C:\Program Files\Odoo Print Manager\odoo-print-manager.exe` exists and that
   `resources\OdooPrintAgent.exe` and `resources\odoo-agent-cli.exe` were installed with it.
4. Launch **Odoo Print Manager**; the tray icon must appear and closing the window must hide
   it rather than exit.

**Record:** installer type, version, install path, WebView2 present/installed.

## 2. Start the agent

1. In the desktop app: **Settings → Gateway URL** → the gateway base URL → save.
2. **Start Agent** (installs/starts the `OdooPrintAgent` service).
3. Verify: `sc query OdooPrintAgent` → `RUNNING`.
4. Verify the log exists and is being written:
   `C:\ProgramData\OdooPrintAgent\logs\agent.log`.

**Record:** service state, log path, agent version.

## 3. Register (pair)

1. In the gateway dashboard, create an agent for the target branch and copy the 6-character
   pairing code (valid 30 minutes, single use).
2. In the desktop app: **Settings → Pair** → enter the code → confirm.
3. Verify `C:\ProgramData\OdooPrintAgent\config.yaml` now contains `agent.id`
   (the secret is DPAPI-sealed).
4. Verify the agent appears in the dashboard with the correct branch.

**Record:** `agentId`, `branchId`, pairing timestamp.

## 4. Heartbeat

1. Wait ≤ 30 s.
2. Dashboard: the agent shows `online` and `lastSeenAt` advances.
3. `GET /api/health` (no auth) returns `{ok:true}` (liveness only — no inventory counts).
4. Dashboard / `GET /api/agents` (manager session) shows the agent `online`.
5. `agent.log` contains periodic heartbeat lines with no errors.

**Record:** first heartbeat time, agent status from the authenticated agents list.

## 5. Printer discovery

1. Desktop app → **Printers → Discover** (or `odoo-agent-cli.exe printers discover`).
2. The Windows spooler queue(s) must be listed with the correct name, port and driver.
3. `C:\ProgramData\OdooPrintAgent\printers.json` contains the printer with a stable
   `printer_spooler_<hex>` id.

**Record:** `printerId`, printer name, port, driver, discovery source.

## 6. Capabilities

1. After the next heartbeat, fetch the printer from the gateway
   (`GET /api/printers` as manager, or the dashboard).
2. Verify `capabilities.supported_protocols` contains `raw`, `escpos` **and** `pdf` for the
   spooler printer, and only `raw`/`escpos` for a RAW/TCP thermal printer.

**Record:** the exact `capabilities` JSON per printer.

## 7. Odoo — branch

1. **Print Gateway → Branches** → create/select the branch.
2. Set `gateway_url` and a branch-scoped API key created with `POST /api/odoo/keys`.
3. Press **Test Connection** → success.

**Record:** Odoo branch id, gateway `branchId`, key id (never the key itself).

## 8. Odoo — destination

Create a destination in that branch (e.g. `Office`, type `pos`).
**Record:** `destinationId`.

## 9. Odoo — document type

Create a document type (e.g. `invoice`) in that branch.
**Record:** document type id and name.

## 10. Odoo — printer binding

1. Press **Sync From Gateway** so the discovered printer is mirrored into Odoo.
2. Create a binding: destination + document type → the discovered printer, priority 1,
   enabled.
3. Press **Sync To Gateway** → it must return success (HTTP 200). If it reports
   `SYNC_DEPENDENCY_MISSING`, the printer is not registered yet — repeat step 5/6.

**Record:** binding id, sync response.

## 11. Odoo — report mapping

Map the report you will print (e.g. `account.report_invoice`) to the document type with
`payload_type = pdf`, `gateway_enabled = true` — either through **Report Mappings** or by
ticking *Gateway Printing Enabled* on the report itself.

**Record:** mapping id, report XML id, payload type.

## 12. Generate a real QWeb PDF

Open a real record (e.g. a posted customer invoice) and press **Print** for the mapped
report. Odoo renders the QWeb PDF and submits it as `{"type":"pdf",…}`.

## 13. Submit and capture identifiers

From the Odoo notification and `print_gateway.print_job`, and from
`GET /api/print/jobs?id=<jobId>&branchId=<branchId>`, record:

`jobId`, `branchId`, `destinationId`, `documentType`, `printerId`, `agentId`.

## 14. Verify gateway state transitions

Poll `GET /api/print/jobs?id=<jobId>&branchId=<branchId>` (or watch the dashboard) and
confirm the sequence:

```
queued → claimed → printing → success
```

Also confirm in the database (or via the manager API) that `claimed_at`, `delivered_at` and
`acked_at` are set and that `retries = 0`, `delivery_attempts = 1`.

## 15. Verify agent logs

`C:\ProgramData\OdooPrintAgent\logs\agent.log` must show, for this `jobId`:
job received over the WebSocket, `job_ack` sent, `Printing job … type=pdf path=pdf`,
the PDF pipeline submitting through the handler, and `payload transmitted successfully`.
There must be **no** temp `.pdf` file left in `%TEMP%` afterwards.

## 16. Verify physical output

Confirm the printed page: correct document, correct pagination, correct printer, readable
(not raw PDF source text). Keep the page or a photo as evidence.

## 17. Verify final status

`GET /api/print/jobs?id=<jobId>` returns `status: "success"`, `error: null`; the Odoo
`print_gateway.print_job` shows `success` after the 2-minute status cron (or a manual
**Sync Status**).

## 18. Deliberate capability mismatch

1. Bind the same destination + document type to a RAW/ESC-POS-only printer (TCP :9100,
   `supported_protocols` without `pdf`) with a higher priority, or temporarily disable the
   spooler binding.
2. Print the same PDF report again.
3. Expected: **HTTP 422** with `code: "CAPABILITY_MISMATCH"`, **no job row created**, an
   error surfaced in Odoo, and **no output at all on the thermal printer**.
4. If the mismatch is only detected by the agent, the job must end `failed` with
   `error` starting `CAPABILITY_MISMATCH:` — and still no garbage output.

**Record:** HTTP status, error body, physical output (must be none).

## 19. Deliberate failure and retry

1. Power off / disconnect the target printer (or pause the Windows queue).
2. Print the report again.
3. Expected: the job reaches `printing` then `failed` with the real Windows error, or the
   claim goes stale and is reclaimed with `retries + 1` under the **same jobId**
   (never a new job id), and after 5 retries it fails permanently.
4. Restore the printer and print once more → `success`.

**Record:** jobId, observed statuses, `retries`, error text.

## 20. Optional — crash behaviour

1. While a large job is printing, stop the service abruptly
   (`taskkill /F /IM OdooPrintAgent.exe`).
2. Start it again.
3. Expected: the agent logs `AGENT_RESTART_DURING_PRINT` for that job and reports it as
   `failed` with the "physical output is unknown" reason.
4. With `agent.reprint_after_crash: false` in `config.yaml`, a re-delivery of that job must
   **not** print again; with the default `true` it may print again (possible duplicate page).

**Record:** which policy was used and what came out of the printer.

---

## Result table (fill in from a real run)

| # | Step | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Install MSI/EXE | Installed, tray icon | | ☐ |
| 2 | Service running | `sc query` = RUNNING | | ☐ |
| 3 | Pairing | `agentId` written, agent visible | | ☐ |
| 4 | Heartbeat | `online`, `lastSeenAt` advancing | | ☐ |
| 5 | Discovery | Spooler printer found, stable id | | ☐ |
| 6 | Capabilities | `supported_protocols` correct per printer | | ☐ |
| 7 | Odoo branch | Test Connection OK | | ☐ |
| 8 | Destination | Created | | ☐ |
| 9 | Document type | Created | | ☐ |
| 10 | Binding + sync to gateway | HTTP 200 | | ☐ |
| 11 | Report mapping | `payload_type = pdf` | | ☐ |
| 12 | QWeb PDF render | PDF generated | | ☐ |
| 13 | Job submitted | ids recorded (below) | | ☐ |
| 14 | Gateway transitions | queued→claimed→printing→success | | ☐ |
| 15 | Agent logs | ack + PDF path + temp file removed | | ☐ |
| 16 | Physical output | Correct page printed | | ☐ |
| 17 | Final status | `success` in gateway and Odoo | | ☐ |
| 18 | Capability mismatch | 422, no job, no output | | ☐ |
| 19 | Deliberate failure + retry | same jobId, real error, recovery | | ☐ |
| 20 | Crash behaviour (optional) | interruption reported, policy honoured | | ☐ |

### Identifiers from the successful run

| Field | Value |
|---|---|
| `jobId` | |
| `branchId` | |
| `destinationId` | |
| `documentType` | |
| `printerId` | |
| `agentId` | |
| Final status | |
| Timestamp | |

### Identifiers from the deliberate-failure run

| Field | Value |
|---|---|
| `jobId` | |
| Failure mode (capability mismatch / offline printer) | |
| HTTP status / `job.error` | |
| Physical output (must be none for a mismatch) | |
| Final status | |

Until both tables are filled in from a real machine, the correct wording everywhere else in
this repository is: **`NOT VERIFIED — physical printer test unavailable`**.
## Production Engineering Semantics

- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.

