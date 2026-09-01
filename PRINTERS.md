# Printers — Supported, Semantics, Truth

## Supported

| Type/Protocol | Status | Transport | Notes |
|---------------|--------|-----------|-------|
| Network `raw` | ✅ Implemented | RAW TCP `ip:port` (usually 9100) | `NetworkPrinter.Print` `agent/internal/printer/network.go:13` — DialContext 5s + deadline 15s + short-write loop. |
| Network `escpos` | ✅ Implemented | Same RAW TCP above | ESC/POS bytes are payload, not transport. `'\x1b\x40'` init, `'\x1d\x56\x01'` cut via `src/lib/payload.ts:18`. |
| Network `ipp`/`ipps` | ✅ Implemented | HTTP POST `application/ipp` (Print-Job) | `IPPPrinter` `agent/internal/printer/ipp.go:24` — URL normalization (`ipp://`/`http://`, bare `host:port`), `Get-Printer-Attributes`, context deadline. Gateway capability check allows raw/escpos/pdf → IPP. |
| USB via Spooler | ✅ Implemented | Windows Spooler `winspool.drv` | USB printers installed as Windows printers use spooler path (`NewSpooler`); install USB via Windows → `type spooler` with `spooler_name`. See `PRINTERS.md` USB section. |
| USB raw | ✅ Implemented (device path) | `CreateFile(\?\usb#...)` + `WriteFile` | `USBPrinter.Print` `usb_windows.go:36` — real write loop; if no Windows device path was discovered it returns an explicit diagnostic error guiding installation as a Windows printer (spooler type). Non-Windows stub writes to `/tmp/printer-usb-*.prn` for CI. |
| Windows Spooler | ✅ Implemented | `winspool.drv` `spooler_windows.go` / stub `spooler_stub.go` | `raw`/`escpos`: `SpoolerPrinter.Print` `OpenPrinterW` → `StartDocPrinterW` (RAW datatype) → `WritePrinter` loop → `EndDocPrinter`. `pdf`: the PDF pipeline below (`PrintDocument`), **not** the RAW datatype. Non-Windows stub writes `/tmp/spooler_*.prn` (raw/escpos) or `/tmp/spooler_*.pdf` (simulated PDF) for CI/test. `Status()` via `OpenPrinterW` probe. |

## Payload types vs. printer types

The job payload type (`raw` / `escpos` / `pdf`) is carried end to end and decides the physical path. It is never rewritten or downgraded.

| Backend | `raw` | `escpos` | `pdf` |
|---------|-------|----------|-------|
| Network RAW TCP (9100) | ✅ bytes on the socket | ✅ bytes on the socket | ❌ `CAPABILITY_MISMATCH` — a 9100 byte stream has no renderer |
| USB raw (`CreateFile`+`WriteFile`) | ✅ | ✅ | ❌ `CAPABILITY_MISMATCH` — install the device as a Windows printer and route to the spooler queue |
| Windows Spooler | ✅ RAW datatype | ✅ RAW datatype | ✅ PDF pipeline (see below) |
| IPP / IPPS | ✅ `application/octet-stream` | ✅ `application/octet-stream` | ✅ `application/pdf` |

Each backend declares this via `SupportsKind` (`agent/internal/printer/document.go`) and reports it to the gateway in the heartbeat as `capabilities.supported_protocols`, so `resolvePrinterForJob` can refuse an incompatible job *before* it is queued (HTTP 422 `CAPABILITY_MISMATCH`). Explicitly configured `supported_protocols` are never overwritten, and `pdf` is never inferred from `raw` support.

## PDF printing (real, not RAW passthrough)

`agent/internal/printer/pdf.go` + `pdf_windows.go`:

1. **Validate** — the payload must actually be a PDF: `%PDF-` within the first 64 bytes, `%%EOF` in the last 4 KiB, non-empty, ≤ 5 MiB (the shared payload limit is preserved).
2. **Materialize securely** — `os.MkdirTemp` (0700) + `os.CreateTemp` (0600). File and directory names come from the OS random-name APIs; nothing from the job, printer name or payload metadata influences the path.
3. **Submit through a PDF-aware mechanism** —
   - configured helper (any OS): `agent.pdf_print_command` in `config.yaml`, e.g.
     `pdf_print_command: ["C:\\Tools\\SumatraPDF.exe", "-print-to", "{printer}", "-silent", "{file}"]`.
     `{printer}` and `{file}` are substituted as **whole argv elements** and executed with `exec.CommandContext` — no shell, no string concatenation, so a printer name containing spaces, `&`, `;` or quotes can never become a command.
   - Windows default: `ShellExecuteExW` with the `printto` verb → the registered PDF handler renders the document through the printer's Windows driver.
   - Other OSes without a helper: an explicit "not supported" error. **PDF is never downgraded to RAW.**
4. **Wait for the outcome** — `SEE_MASK_NOCLOSEPROCESS` + `WaitForSingleObject` + `GetExitCodeProcess` (or `cmd.Run()` for the helper). A non-zero exit, a timeout (120 s default) or a missing handler is a real error reported back to the gateway; it is never reported as success.
5. **Clean up** — the temp directory is removed on every exit path (success, failure, panic).

Printer names are validated before use (`ValidatePDFPrinterName`): no control characters, no quotes, ≤ 220 bytes. A rejected name fails the job instead of being "sanitized" into a different printer.

## Identity

Stable `printer.id` (`printer_...`), not IP. Deterministic derivation (`printer/stable_id.go`):
  - Spooler: `spooler:<normalized spooler_name>` → hash `printer_spooler_<hex>`
  - USB: `usb-sn:<serial>` → `usb-loc:<location>` → `usb-vidpid:<vid>:<pid>` → `printer_usb_<hex>`
  - Network: `net:<ip>:<port>` → `printer_net_<hex>`; fallback `endpoint:<str>` → `printer_ep_<hex>`
Repeated discovery updates existing record by ID, never creates duplicates (`printer/registry.go: UpsertRegistry`, `discovery.go: seen map`). Discovery is idempotent.

USB `Identify()` `usb_windows.go:30`: `SerialNumber` (L1) → `USBLocation` (L2) → `VID:PID` (L3).

CLI:
  - `odoo-agent-cli.exe printers list` — enumerate aggregated view (config + spooler + registry)
  - `odoo-agent-cli.exe printers discover` — enumerate and persist to `printers.json` (beside `config.yaml`), idempotent
  - `odoo-agent-cli.exe printers test <printer-id>` — real `SpoolerPrinter.Test` / `NetworkPrinter.Test` via same backend as jobs
  - `odoo-agent-cli.exe printers add --name ... --type spooler --spooler-name "HP LaserJet" [--protocol spooler]` — manual registration when discovery insufficient (supports tcp/usb/spooler/ipp)
Production flow does NOT depend on `printers: []` in YAML; `printers.json` registry + Gateway DB is canonical (`discovery.go`, `registry.go`).

## Discovery Sources (isolated, never crash agent, additive)

- `discoverFromConfig` (YAML legacy, backward compat) `discovery.go:140`
- `discoverSpoolerPrinters` (Windows `EnumPrintersW` level 2 with correct `PRINTER_INFO_2W` parsing via `unsafe.Sizeof` `spooler_windows.go:143`, stub on non-Windows `spooler_stub.go`) — extracts `pPrinterName`, `pPortName`, `pDriverName`, `pShareName`, `pLocation`, `pComment`, `Attributes`, `Status` → maps to `DeviceInfo` with `printerType`/`connectionType` classification `classify.go:3` and `mapWindowsStatus` `classify.go:51`
- `loadRegistryPrinters` (`printers.json` previously discovered/manual) `registry.go:31`
- `discoverNetworkPrinters` (active LAN TCP 9100 scan) `network_discovery.go:9` — enumerates private IPv4 subnets via `net.Interfaces`, clamps `/16`/`/8` to `/24`, bounded 32 workers, per-host 500ms, global 8s timeout, respects `context` cancellation, logs `found TCP printer` and dedup via `StableIDFromNetwork`
- `discoverUSBPrinters` (Windows `SetupDiGetClassDevsW` `DIGCF_PRESENT|ALLCLASSES`) `usb_windows.go:34` — enumerates `USB\VID_&PID_`/`USBPRINT` devices, parses VID/PID/serial via `parseVIDPIDSerial`, friendly name via `SPDRP_FRIENDLYNAME`, `SPDRP_MFG`, `SPDRP_LOCATION_INFORMATION`, builds `DeviceInfo` with `usbVid/pid/serial` and `requires_spooler` diagnostic
- `mDNS` (`_ipp._tcp`, `_printer._tcp`), `SNMP` (`1.3.6.1.2.1.43`), `WSD` currently stub-logged as `not yet implemented` `network_discovery.go:52` — additive, not replacing spooler; discovery is idempotent via `seen` map by stable ID + cross-source dedup by `NetworkAddress:Port` and `USB VID:PID:serial` `discovery.go:37`

Merges with `seen` map by stable ID + `NetworkAddress:Port`/`USB` dedup `discovery.go:57`; per-source `recover()` so one failing printer never crashes agent (`discovery.go:64`). Logs `[discovery] starting ...`, `[discovery] found ...`, `[discovery] duplicate merged`, `[discovery] discovery completed` (no secrets).

Manual registration: `printer.RegisterManual` → `UpsertRegistry` → persisted atomically (`registry.go:102`). Supports `id`, `name`, `printerType`, `connectionType`, `endpoint`, `protocol`, `spoolerName`, `usbVid/pid/serial`, `capabilities`, `enabled` (`cli/main.go:240`, `helpers.go:84`). On Windows, manual `spooler` requires `spooler_name`/`endpoint`; for USB via spooler, set `type spooler` + spooler name. `tcp` alias `network` is canonicalized (`config.go: NormalizedType`). `ipp`/`ipps` creates a real `IPPPrinter` (`factory.go`). Network `192.168.1.10:9100` YAML continues working.

## Manual Registration Examples

```powershell
# Network RAW 9100 (thermal ESC/POS)
odoo-agent-cli.exe printers add --name "Kitchen 9100" --type network --endpoint 192.168.1.50:9100 --protocol escpos --printer-type thermal

# Windows spooler (local or network share, USB installed as Windows printer)
odoo-agent-cli.exe printers add --name "Office Laser" --type spooler --spooler-name "HP LaserJet M402" --printer-type laser

# USB with VID/PID (discovered but requires spooler queue for printing)
odoo-agent-cli.exe printers add --name "Zebra Label" --type usb --vid 0A5F --pid 014E --serial 123456 --printer-type label --spooler-name "Zebra GK420d"

# IPP (real IPP client; requires a running IPP server on the endpoint)
odoo-agent-cli.exe printers add --name "Office IPP" --type ipp --endpoint ipp://192.168.1.60/ipp/print --protocol ipp
# → factory.New creates IPPPrinter; Print POSTs application/ipp Print-Job to the endpoint
```

Registry `printers.json` beside `config.yaml` is canonical; `printers: []` YAML may be empty. `config.yaml` example with `server.url`, `agent.id/secret`, empty `printers: []` continues to parse and Agent stays alive with `INFO: no printers configured` (`agent.go:160`).

## Firewall / Windows Permissions

- Agent requires outbound `HTTPS/WSS` to Gateway (no inbound ports).
- Network discovery probes `TCP 9100` outbound on private subnets; Windows Firewall may block 9100 outbound — allow.
- mDNS uses UDP 5353 multicast 224.0.0.251 (currently stub, future).
- SNMP uses UDP 161 (stub).
- WSD uses WS-Discovery multicast (stub).
- Spooler enumeration requires no elevation; reading `printers.json`/`config.yaml` under `%PROGRAMDATA%\OdooPrintAgent` requires ACL `SYSTEM:F, Administrators:F` (installer creates). Running CLI non-elevated falls back to `%LOCALAPPDATA%`.
- `SetupDi` USB enumeration requires no elevation for present devices; reading device instance IDs is allowed for standard users.

## Diagnostics (split)

- `POST /api/printers/:id/test-connection` — **RPC, no job** `test-connection/route.ts`. Returns `{reachable,status,agentOnline}` = last heartbeat `printer.status` + agent freshness. Gateway does NOT dial LAN.
- `POST /api/printers/:id/test-print` — **real job** `queued→claimed→(delivery)→printing→success/failed` (Gateway PG) and local `queued→printing→success/failed` (Agent WAL). The job is claimed by the gateway *before* it is pushed over the WebSocket, so a status can never regress to `queued` after the agent started. `success` = the transport accepted the document (socket write completed / spooler accepted the job / PDF handler exited 0), **NOT** `paper physically out`. Dashboard shows helper text.

## Success Semantics (honest)

`NetworkPrinter.Print` success means the kernel accepted the bytes on TCP; POS printers rarely ack paper. For the PDF path, success means the PDF handler exited 0 after being handed the document for the named printer — i.e. the submission is proven, the physical page is not. Do not claim paper-out without bidirectional status polling (not implemented). Retry on dial/write error only; `failed` after `retries>=5` and stale 90s reclaim.

## Limits

- Payload 5 MiB `agent/internal/payload/payload.go:31` + `src/lib/payload.ts:6` (base64 pre-check).
- `NetworkPrinter.Print` refuses empty and >5 MiB; rejects non-`ip:port` at `ValidatePrinterConfig` `config.go:138`.
- Per-printer `sync.Mutex` `agent.go:341` — same printer serial, different printers concurrent (`agent_test.go`).

## Error Handling

- Dial 5s, total deadline 15s or context deadline, write loop handles short writes.
- Agent crash window: `queued→printing` in SQLite but crash before `PATCH success` → Gateway reclaim after 90s may cause a duplicate physical print if the printer already received the bytes — at-least-once over the socket during the crash window, not exactly-once. A job that *completed* locally is protected: a duplicate delivery re-reports the stored terminal result instead of printing again (`agent/internal/agent/agent.go`, local SQLite queue).
- Delivery failures do not strand jobs: a WS delivery that fails after the claim requeues the same job id (max 5 delivery attempts, then an explicit `failed`), and a silent claim is reclaimed after the 90 s lease with `retries+1`.