# Printers — Supported, Semantics, Truth

## Supported

| Type/Protocol | Status | Transport | Notes |
|---------------|--------|-----------|-------|
| Network `raw` | ✅ Implemented | RAW TCP `ip:port` (usually 9100) | `NetworkPrinter.Print` `agent/internal/printer/network.go:13` — DialContext 5s + deadline 15s + short-write loop. |
| Network `escpos` | ✅ Implemented | Same RAW TCP above | ESC/POS bytes are payload, not transport. `'\x1b\x40'` init, `'\x1d\x56\x01'` cut via `src/lib/payload.ts:18`. |
| Network `ipp` | ❌ Not implemented (honest error) | — | `printer.New` returns error `ipp not implemented` (`factory.go`). IPP protocol accepted in registry but execution requires IPP client — returns `CAPABILITY_MISMATCH` at Gateway before queuing. |
| USB via Spooler | ✅ Implemented | Windows Spooler `winspool.drv` | USB printers installed as Windows printers use spooler path (`NewSpooler`); install USB via Windows → `type spooler` with `spooler_name`. See `PRINTERS.md` USB section. |
| USB raw | Stub (honest error) | — | `printer.New` returns error with guidance to use spooler (`factory.go`); `Identify()` via SN→LOC→VIDPID exists (`usb_windows.go:30`) but direct raw USB needs spooler. |
| Windows Spooler | ✅ Implemented | `winspool.drv` `spooler_windows.go` / stub `spooler_stub.go` | `SpoolerPrinter.Print` `OpenPrinterW` → `StartDocPrinterW` (RAW) → `WritePrinter` loop → `EndDocPrinter`. Non-Windows stub writes to `/tmp/spooler_*.prn` for CI/test. `Status()` via `OpenPrinterW` probe. |

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

Manual registration: `printer.RegisterManual` → `UpsertRegistry` → persisted atomically (`registry.go:102`). Supports `id`, `name`, `printerType`, `connectionType`, `endpoint`, `protocol`, `spoolerName`, `usbVid/pid/serial`, `capabilities`, `enabled` (`cli/main.go:240`, `helpers.go:84`). On Windows, manual `spooler` requires `spooler_name`/`endpoint`; for USB via spooler, set `type spooler` + spooler name. `tcp` alias `network` is canonicalized (`config.go: NormalizedType`). `ipp` manual persists but `printer.New` will reject printing with honest `ipp not implemented` error — never silent success. Network `192.168.1.10:9100` YAML continues working.

## Manual Registration Examples

```powershell
# Network RAW 9100 (thermal ESC/POS)
odoo-agent-cli.exe printers add --name "Kitchen 9100" --type network --endpoint 192.168.1.50:9100 --protocol escpos --printer-type thermal

# Windows spooler (local or network share, USB installed as Windows printer)
odoo-agent-cli.exe printers add --name "Office Laser" --type spooler --spooler-name "HP LaserJet M402" --printer-type laser

# USB with VID/PID (discovered but requires spooler queue for printing)
odoo-agent-cli.exe printers add --name "Zebra Label" --type usb --vid 0A5F --pid 014E --serial 123456 --printer-type label --spooler-name "Zebra GK420d"

# IPP (persisted but printing explicitly unsupported)
odoo-agent-cli.exe printers add --name "Office IPP" --type ipp --endpoint ipp://192.168.1.60/ipp/print --protocol ipp
# → printer.New returns "ipp is not implemented" on test/print; Gateway returns CAPABILITY_MISMATCH before queuing
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
- `POST /api/printers/:id/test-print` — **real job** `queued→claimed→printing→success/failed` (Gateway PG) and local `queued→printing→success/failed` (Agent WAL). `success` = socket write OK (`Print` loop completed), **NOT** `paper physically out`. Dashboard shows helper text.

## Success Semantics (honest)

`NetworkPrinter.Print` success means kernel accepted bytes on TCP; POS printers rarely ack paper. Do not claim paper-out without bidirectional status polling (not implemented). Retry on dial/write error only; `failed` after `retries>=5` and stale 90s reclaim.

## Limits

- Payload 5 MiB `agent/internal/payload/payload.go:31` + `src/lib/payload.ts:6` (base64 pre-check).
- `NetworkPrinter.Print` refuses empty and >5 MiB; rejects non-`ip:port` at `ValidatePrinterConfig` `config.go:138`.
- Per-printer `sync.Mutex` `agent.go:341` — same printer serial, different printers concurrent (`agent_test.go`).

## Error Handling

- Dial 5s, total deadline 15s or context deadline, write loop handles short writes.
- Agent crash window: `queued→printing` in SQLite but crash before `PATCH success` → Gateway reclaim after 90s may cause duplicate physical print if printer already received bytes — documented as at-least-once over socket during crash window, not exactly-once.