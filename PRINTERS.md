# Printers — backends, payload semantics, discovery

Source: `agent/internal/printer/*.go`, `src/lib/routing.ts`, `src/lib/payload.ts`.

Verification labels used below:
**VERIFIED** = executed in this repository's automated tests ·
**COMPILE VERIFIED** = builds and vets for the target platform but was never executed ·
**SIMULATED** = a non-Windows development stand-in ·
**NOT VERIFIED** = requires hardware nobody has exercised here.

## 1. Payload types

The job payload is one of three non-interchangeable kinds
(`agent/internal/printer/document.go`):

| type | meaning | agent path |
|---|---|---|
| `raw` | opaque printer-native byte stream | written verbatim to the transport |
| `escpos` | ESC/POS command stream (`ESC @` init … `GS V` cut) | written verbatim to the transport (ESC/POS is a payload dialect, not a transport) |
| `pdf` | a real PDF document | PDF pipeline: validate → secure temp file → PDF-aware submission → wait → delete temp file |

**A PDF is never converted into RAW printer bytes, never renamed, and never "assumed
supported because the printer accepts raw".** Sending PDF bytes to an ESC/POS byte-stream
printer produces pages of garbage, so it is refused with `CAPABILITY_MISMATCH`.

## 2. Backend / payload matrix

| Backend | Implementation | `raw` | `escpos` | `pdf` | Physical verification |
|---|---|---|---|---|---|
| Network RAW TCP (usually :9100) | `network.go` | ✅ | ✅ | ❌ `CAPABILITY_MISMATCH` (a 9100 byte stream has no renderer) | **NOT VERIFIED** (tested against a local mock listener — VERIFIED at socket level) |
| Windows spooler | `spooler_windows.go` | ✅ RAW datatype (`StartDocPrinterW`) | ✅ RAW datatype | ✅ PDF pipeline (§4) | **COMPILE VERIFIED** only |
| Windows spooler (non-Windows build) | `spooler_stub.go` | writes `<tmp>/spooler_*.prn` | same | validates the PDF and writes `<tmp>/spooler_*.pdf`, logged as SIMULATED | **SIMULATED** |
| IPP / IPPS | `ipp.go` | ✅ `application/octet-stream` | ✅ `application/octet-stream` | ✅ `application/pdf` | **NOT VERIFIED** against a real IPP printer (`httptest` coverage only) |
| USB raw (`CreateFile` + `WriteFile`) | `usb_windows.go` | ✅ | ✅ | ❌ `CAPABILITY_MISMATCH` — install the device as a Windows printer and route to the spooler queue | **COMPILE VERIFIED** only |
| USB raw (non-Windows build) | `usb_other.go` | simulated file write | same | ❌ | **SIMULATED** |

Each backend declares what it accepts through `SupportsKind`, and
`printer.SupportedKinds()` is reported to the gateway in the heartbeat as
`capabilities.supported_protocols`, so routing can refuse an incompatible job **before** it
is queued. An explicitly configured `supported_protocols` list is never overwritten.

## 3. Capability enforcement (two layers)

**Gateway** (`validatePayloadForPrinter` in `src/lib/routing.ts`):

* if the printer declares `capabilities.supported_protocols`, that list is authoritative;
  `raw`/`escpos` may additionally travel over any byte-stream transport (spooler), but
  **`pdf` is never inferred from `raw` support**;
* without a declared list the transport decides: `pdf` requires a spooler or IPP/IPPS
  printer and is refused for raw-TCP/USB devices; `raw`/`escpos` are accepted by raw,
  escpos, spooler and IPP transports.

A mismatch is `CAPABILITY_MISMATCH` → HTTP **422** at job creation, and the routing layer
tries the next binding by priority before giving up.

**Agent** (`processJob` in `agent/internal/agent/agent.go`): re-checks `SupportsKind`
before anything is written anywhere and fails the job with
`CAPABILITY_MISMATCH: printer <id> cannot print <kind> payloads`, which the gateway stores
in `job.error` with `job.status = failed`.

## 4. Windows PDF printing (real, not RAW passthrough)

`agent/internal/printer/pdf.go` + `pdf_windows.go`:

1. **Validate** — must actually be a PDF: `%PDF-` inside the first 64 bytes, `%%EOF` inside
   the last 4 KiB, non-empty, ≤ 5 MiB (the shared payload limit is preserved).
2. **Materialise securely** — `os.MkdirTemp` (0700 directory) + `os.CreateTemp` (0600 file).
   Both names come from the OS random-name APIs; nothing from the job id, printer name or
   payload metadata influences the path.
3. **Submit through a PDF-aware mechanism**
   * configured helper (any OS, first choice when set): `agent.pdf_print_command`, e.g.
     `["C:\\Tools\\SumatraPDF.exe", "-print-to", "{printer}", "-silent", "{file}"]`.
     `{printer}` and `{file}` are substituted as **whole argv elements** and executed with
     `exec.CommandContext` — no shell, no string concatenation;
   * Windows default: `ShellExecuteExW` with the `printto` verb, i.e. the registered PDF
     handler renders the document through the printer's Windows driver;
   * any other OS without a helper: an explicit "not supported" error. **Never a RAW
     fallback.**
4. **Wait for the outcome** — `SEE_MASK_NOCLOSEPROCESS` + `WaitForSingleObject` +
   `GetExitCodeProcess` (or `cmd.Run()` for the helper), 120 s default timeout. A non-zero
   exit, a timeout, or a missing handler is a real error reported to the gateway.
5. **Clean up** — the temp directory is removed on every exit path (success, failure, panic).

Printer names are validated before use (`ValidatePDFPrinterName`): no control characters, no
quote characters, ≤ 220 bytes. A rejected name fails the job instead of being silently
"sanitised" into a different printer.

Status: the pipeline's validation, temp-file lifecycle, argument construction and error
propagation are **VERIFIED** by `agent/internal/printer/pdf_test.go`; the Windows
`ShellExecuteExW` submission itself is **COMPILE VERIFIED** (`GOOS=windows go build/vet`)
and **NOT VERIFIED** on hardware — see [WINDOWS_PHYSICAL_E2E.md](WINDOWS_PHYSICAL_E2E.md).

## 5. Printer identity

Stable ids are derived deterministically (`stable_id.go`), never from the current IP alone:

* spooler: `spooler:<normalised name>` → `printer_spooler_<hex>`
* USB: `usb-sn:<serial>` → `usb-loc:<location>` → `usb-vidpid:<vid>:<pid>` → `printer_usb_<hex>`
* network/IPP: `net:<host>:<port>` (URLs parsed) → `printer_net_<hex>`; fallback
  `endpoint:<string>` → `printer_ep_<hex>`

Repeated discovery updates the existing record (`registry.go: UpsertRegistry`, `seen` map in
`discovery.go`) — discovery is idempotent. The heartbeat upsert is scoped to the reporting
agent, so one agent can never overwrite another agent's printer row.

## 6. Discovery sources

| Source | Status |
|---|---|
| `discoverFromConfig` — printers listed in `config.yaml` | implemented (legacy, still supported) |
| `discoverSpoolerPrinters` — `EnumPrintersW` level 2, correct `PRINTER_INFO_2W` parsing, non-printer PnP entries filtered out | implemented (Windows); **COMPILE VERIFIED** |
| `loadRegistryPrinters` — `printers.json` next to `config.yaml` | implemented, atomic writes |
| `discoverNetworkPrinters` — active TCP 9100 scan of private IPv4 subnets, `/16`+ clamped to `/24`, 32 workers, 500 ms per host, 8 s global budget | implemented |
| `discoverUSBPrinters` — `SetupDiGetClassDevsW`, VID/PID/serial parsing, device-interface path map | implemented (Windows); **COMPILE VERIFIED** |
| `discoverIPPPrinters` — TCP 631 scan (+ best-effort name lookup) | implemented |
| mDNS (`_ipp._tcp`, `_printer._tcp`), SNMP (`1.3.6.1.2.1.43`), WSD | **NOT IMPLEMENTED** — they only log "not yet implemented" and return nothing (`network_discovery.go`, `ipp_discovery.go`) |

`DiscoverQuick` (config + spooler + registry) runs synchronously at startup so the agent is
usable immediately; the full scan (network + USB + IPP) runs asynchronously ~2 s later.
Every source is isolated with `recover()`, so one failing source can never crash the agent,
and results are de-duplicated by stable id, `address:port` and `VID:PID:serial`.

## 7. Manual registration

```powershell
# Network RAW 9100 (thermal ESC/POS)
odoo-agent-cli.exe printers add --name "Kitchen 9100" --type network --endpoint 192.168.1.50:9100 --protocol escpos --printer-type thermal

# Windows spooler queue (local, shared, or a USB printer installed as a Windows printer)
odoo-agent-cli.exe printers add --name "Office Laser" --type spooler --spooler-name "HP LaserJet M402" --printer-type laser

# USB with VID/PID (still needs a spooler queue for PDF work)
odoo-agent-cli.exe printers add --name "Zebra Label" --type usb --vid 0A5F --pid 014E --serial 123456 --printer-type label --spooler-name "Zebra GK420d"

# IPP
odoo-agent-cli.exe printers add --name "Office IPP" --type ipp --endpoint ipp://192.168.1.60/ipp/print --protocol ipp
```

Other CLI verbs: `printers list`, `printers discover`, `printers test <id>`,
`printers remove <id>`, plus `-config <path>` and `--json`.
`printers.json` is canonical; `printers: []` in `config.yaml` is fine.

## 8. Diagnostics

* `POST /api/printers/:id/test-connection` — **no job is created**. Returns the cached
  heartbeat reachability (`latencyMs` is always `null`; the gateway cannot dial the LAN and
  a live agent probe is not implemented).
* `POST /api/printers/:id/test-print` — **a real job** through the normal pipeline
  (`queued → claimed → delivery → printing → success|failed`), using an ESC/POS test payload.

## 9. Success semantics (honest)

* RAW TCP success = the kernel accepted the bytes on the socket. POS printers rarely
  acknowledge paper.
* Spooler success = `WritePrinter`/`EndDocPrinter` returned success, i.e. the job was
  accepted by the Windows spooler.
* PDF success = the PDF handler exited 0 after being handed the document for that printer.
* IPP success = the printer answered IPP status `0x0000`.

None of these prove that a physical page came out. Bidirectional paper-level status is not
implemented.

## 10. Limits and known behaviour

* Payload: 1 B … 5 MiB decoded, enforced on both sides (`payload.go`, `payload.ts`).
* One `sync.Mutex` per printer: jobs for the same printer are serialised, different
  printers run concurrently (max 8 executing, 64 accepted — `agent.go`).
* Physical print timeout: 20 s context per job (PDF submission has its own 120 s bound).
* Crash window: a job that was printing when the agent stopped has an unknown physical
  outcome. The agent now reports it explicitly (`AGENT_RESTART_DURING_PRINT`) and
  `agent.reprint_after_crash` decides whether it may be printed again. This is
  **at-least-once** delivery made visible — not exactly-once printing. See
  [docs/JOB_LIFECYCLE.md](docs/JOB_LIFECYCLE.md) §9.
