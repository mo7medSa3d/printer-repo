# Printers — Supported, Semantics, Truth

## Supported

| Type/Protocol | Status | Transport | Notes |
|---------------|--------|-----------|-------|
| Network `raw` | Implemented | RAW TCP `ip:port` (usually 9100) | `NetworkPrinter.Print` `agent/internal/printer/network.go:13` — DialContext 5s + deadline 15s + short-write loop. |
| Network `escpos` | Implemented | Same RAW TCP above | ESC/POS bytes are payload, not transport. `'\x1b\x40'` init, `'\x1d\x56\x01'` cut via `src/lib/payload.ts:18`. |
| Network `ipp` | Not implemented | — | `printer.New` returns error `ipp not implemented` — do NOT expect office lasers on 9100 to print arbitrary data. |
| USB | Stub | — | `printer.New` returns `USB not yet implemented` `usb_windows.go:41`; `Identify()` via SN→LOC→VIDPID exists but `Print` errors. |
| Windows Spooler | Planned | `winspool.drv` | Future `OpenPrinterW/WritePrinter`. |

## Identity

Stable `printer.id` (`printer_...`), not IP. Gateway `printers` PK `printer.id`; heartbeat upserts scoped to `agent.id` `heartbeat/route.ts:60`. Change IP → update `config.ip` but keep same `id`.

USB `Identify()` `usb_windows.go:30`: `SerialNumber` (L1) → `USBLocation` (L2) → `VID:PID` (L3).

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

