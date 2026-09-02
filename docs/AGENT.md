# Agent (Go, Windows service)

Source: `agent/` — `cmd/agent`, `cmd/cli`, `internal/{agent,config,printer,payload,queue,storage,diag}`.
Built with Go 1.21+ (`agent/go.mod`).

## 1. Processes and binaries

| Binary | Purpose |
|---|---|
| `OdooPrintAgent.exe` (`cmd/agent`) | The service: heartbeat, job delivery, printing |
| `odoo-agent-cli.exe` (`cmd/cli`) | Local administration: `printers list \| discover \| test <id> \| add \| remove` (`-config <path>`, `--json`) |

Service control uses `kardianos/service`:
`OdooPrintAgent.exe -service install|uninstall|start|stop|restart`, plus
`-config <path>` to point at a non-default configuration file. The Tauri desktop app bundles
both executables and drives the same commands.

## 2. Runtime paths

Resolved in `internal/config/config.go`:

1. `ODOO_PRINT_AGENT_DATA_DIR` (environment override, highest priority)
2. `%PROGRAMDATA%\OdooPrintAgent` (Windows default)
3. `%LOCALAPPDATA%\OdooPrintAgent` (per-user fallback when ProgramData is not writable)
4. the executable's directory (legacy)

Inside that directory: `config.yaml`, `agent.db` (SQLite queue, WAL),
`printers.json` (discovery registry), `logs/agent.log` (rotated at 5 MiB, 3 old files kept),
and the sealed secret store (DPAPI on Windows, 0600 base64 file elsewhere —
`internal/storage`).

On a fresh start the agent creates the directory and a safe default `config.yaml`
(`config.Ensure`) and keeps running even with no printers configured.

## 3. Configuration file

```yaml
server:
  url: https://gateway.example.com        # gateway base URL (no trailing slash)

agent:
  id: agt_7f3c                            # written by pairing
  secret: "<agent secret>"                # written by pairing; DPAPI-sealed on Windows
  name: "POS PC 1"
  # Optional: external PDF print helper. {printer} and {file} are substituted as
  # whole argv elements and executed WITHOUT a shell.
  pdf_print_command: ["C:\\Tools\\SumatraPDF.exe", "-print-to", "{printer}", "-silent", "{file}"]
  # Optional: may a job that was interrupted mid-print be printed again when the
  # gateway re-delivers it? true (default) = at-least-once, may duplicate paper.
  # false = never reprint automatically; the interruption is re-reported instead.
  reprint_after_crash: true

printers:                                  # optional/legacy: printers.json is canonical
  - id: printer_kitchen
    name: Kitchen
    type: network                          # network|tcp|usb|spooler|ipp|ipps
    endpoint: 192.168.1.50:9100
    protocol: escpos                       # raw|escpos|ipp|spooler|windows_spooler
    printer_type: thermal
    spooler_name: ""                       # required for type: spooler
    usb_vid: ""
    usb_pid: ""
    usb_serial: ""
    enabled: true
    capabilities:
      supported_protocols: [raw, escpos]   # overrides the auto-reported list
```

`config.Validate()` rejects an empty/invalid `server.url` and malformed printer entries
(`ValidatePrinterConfig`); `type: network` requires a parsable `host:port`.

## 4. Startup sequence

1. Resolve the config path, create the runtime directory, open `agent.log`.
2. Load `config.yaml`; register `agent.pdf_print_command` as the global PDF helper.
3. Open the SQLite queue (WAL, `busy_timeout=5000`, single writer connection).
4. `DiscoverQuick` (config + spooler + registry) synchronously, then merge into
   `printers.json`; full discovery (network 9100, USB, IPP 631) runs asynchronously ~2 s later.
5. **Crash recovery**: every local job still in `printing` is marked
   `AGENT_RESTART_DURING_PRINT` and reported to the gateway as failed
   (`recoverInterruptedJobs`) — see [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md) §9.
6. Start the WebSocket connector, then the heartbeat (30 s) and poll (10 s) tickers, and
   send one immediate heartbeat + poll.
7. Without an `agent.id` the process stays alive and idle so the desktop manager can pair it.

## 5. Pairing / registration

`internal/agent/pairing.go`: the agent (or the desktop app) POSTs the 6-character pairing
code to `POST /api/agent/register` together with an optional `branchId` and host metadata,
receives `{agentId, secret}` **once**, and persists them (DPAPI-sealed on Windows).
Subsequent requests use `Authorization: Bearer <agentId>:<secret>`.

## 6. Heartbeat

Every 30 s the agent POSTs `/api/agent/heartbeat` with its status and one entry per known
printer: id, name, canonical `printerType` + `deviceClass` + `connectionType` + `protocol`, live `status()` probe result,
`enabled`, transport config (spooler name, ip/port, USB vid/pid/serial) and
`capabilities`. When the operator has not pinned `supported_protocols`, the agent reports
the backend's real capability list (`printer.SupportedKinds`), which is what the gateway's
capability check uses. Heartbeat ticks are non-reentrant: a slow probe never lets ticks pile
up.

## 7. Job delivery

* **WebSocket** `wss://<gateway>/api/agent/ws`, `Authorization` header, jittered backoff
  5 s → 60 s. Incoming `print_job` envelopes are acknowledged with `job_ack` **before**
  printing (also for duplicates). Protocol: [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).
* **Polling** `GET /api/agent/jobs` every 10 s while the socket is down, and every third tick
  (~30 s) as a safety net while it is up, so a claim whose WebSocket delivery was lost is
  reclaimed after the gateway's 90 s lease.
* Rows returned by either path are already `claimed` server-side; the agent never sees a
  `queued` job.

## 8. Job execution

`dispatchJob` → bounded executor (8 concurrently executing, 64 accepted; overflow is dropped
and re-delivered by the gateway after the lease) with in-flight de-duplication by job id.

`processJob`, in order:

1. TTL check (`expiresAt` in the past → report `expired`, do not print);
2. local terminal check — already `success` locally ⇒ re-report success, never print twice;
   interrupted mid-print and `reprint_after_crash: false` ⇒ re-report the interruption;
3. printer lookup (unknown printer ⇒ explicit failure);
4. `payload.Parse` (strict base64, 5 MiB cap, `raw|escpos|pdf`);
5. capability gate (`SupportsKind`) ⇒ `CAPABILITY_MISMATCH` failure before anything is written;
6. per-printer mutex; local `queue.Push` + `printing`; `PATCH printing`;
7. `printer.PrintDocument` with a 20 s context (PDF goes through the PDF pipeline; raw/escpos
   through the byte-stream path);
8. local `success`/`failed` inside the lock, then `PATCH success|failed` with the real error
   text outside the lock (network I/O never holds the printer mutex).

## 9. Local queue (SQLite, WAL)

`agent/internal/queue/queue.go` — table `print_jobs(id, printer_id, payload, status,
retries, last_error, created_at, updated_at, claimed_at)` with
`status ∈ queued|printing|success|failed`; the id is the **gateway job id**.
`Push` is `INSERT OR IGNORE` (a re-delivery never creates a second local row).
`IsProcessed` guards against duplicate prints after success; `MarkInterrupted`/
`WasInterrupted` implement crash detection; `LastError` allows a stored failure to be
re-reported.

## 10. Shutdown

`Stop` cancels the context, refuses new dispatches, waits up to 25 s for in-flight jobs
(`shutdownGrace`, below the 30 s Windows SCM default), closes the WebSocket and only then
closes the SQLite database, so the queue is never closed mid-write.

## 11. Platform behaviour

| Platform | Behaviour |
|---|---|
| Windows | Full functionality: spooler (RAW + PDF), USB `CreateFile`, `EnumPrintersW`/`SetupDi` discovery, DPAPI secret sealing, service integration. **COMPILE VERIFIED** in this repository (`GOOS=windows go build/vet`), hardware paths **NOT VERIFIED** |
| Linux/macOS | Development and CI only: the spooler backend writes `.prn`/`.pdf` files and logs that it is simulating, raw USB is simulated, `platformPrintPDF` returns an explicit "not supported without a helper" error, secrets fall back to a 0600 base64 file |

## 12. Environment variables

| Variable | Effect |
|---|---|
| `ODOO_PRINT_AGENT_DATA_DIR` | Overrides the runtime directory (config, queue, registry, logs) |
| `RUN_PHYSICAL_PRINTER_TESTS` | Opt-in switch for hardware-dependent Go tests (skipped by default) |
| `GITHUB_ACTIONS`, `PROGRAMDATA`, `LOCALAPPDATA`, `HOME` | Read for path/CI detection only |

## 13. Tests

`agent/internal/**/*_test.go` — 88 Go test functions across 8 packages, all executed with
`go test ./...` and `go test -race ./...`. Highlights: per-printer serialization, duplicate
delivery, TTL, retry, crash window, WebSocket envelope/ack, PDF validation + temp-file
lifecycle + injection safety, IPP request building, discovery classification, secure
storage. Details in [TESTING.md](TESTING.md).
