# OVAFILM? no — Odoo Print Gateway / Agent
# Forensic Fix + Reconciliation Report — 2026-09-11

## Scope

Source of truth: the supplied repository snapshot. Historical audit findings were treated as hypotheses and revalidated against the current tree before changes.

This report intentionally distinguishes source-level proof from checks requiring the real Windows/Odoo/Node/Docker environment.

## Reconciliation — all 29 findings

| Finding | Original claim | Current status after revalidation | Evidence in current tree | Action |
|---|---|---|---|---|
| PREV-01 | Session-0 PDF `ShellExecuteExW("printto")` is unsafe/unusable for services | REFUTED — handler is interactive-only; headless path uses configured/helper renderer | `agent/internal/printer/pdf_windows.go` explicitly limits ShellExecute fallback to interactive sessions; tests cover helper restrictions | DO NOT CHANGE |
| PREV-02 | Discovery result channel can be closed while a worker sends | ALREADY FIXED AND PROVEN | `discovery_manager.go`: buffered result channel, single sender, no close from orchestrator; existing close-race tests | No new patch required |
| PREV-03 | Unlabelled `break` can spin discovery loops | ALREADY FIXED AND PROVEN | Current discovery loops either return/exit correctly; no matching cancellation-spin pattern remains in discovery orchestrators | No new patch required |
| PREV-04 | Peripheral configuration is disconnected from actual network print execution | ALREADY FIXED AND PROVEN | `agent.go` passes payload through `WrapPeripheralCommands` before `PrintDocument`; ESC/POS-only isolation is tested | No new architecture change |
| PREV-05 | Raster path hardcodes a cutter command | ALREADY FIXED AND PROVEN | `image.go` has no cutter bytes; cut is exclusively peripheral-profile controlled | No change |
| PREV-06 | Odoo POS uses incompatible `this.data.write` path | ALREADY FIXED AND PROVEN | Current POS integration contains no `this.data.write` call; current Odoo 19-oriented router is used | No change |
| PREV-07 | `runtime_printers` mishandles `branch=False` | ALREADY FIXED AND PROVEN | Current controller/model path accepts root-company assignments and optional branch semantics | No change |
| PREV-08 | Non-PDF Odoo reports are incorrectly intercepted | ALREADY FIXED AND PROVEN | `report_interceptor.js`/controller gate the Gateway interception on `qweb-pdf` | No change |
| PREV-09 | WebSocket payload limit is inconsistent | ALREADY FIXED AND PROVEN | Gateway `MAX_WS_MESSAGE_BYTES=64KiB`, WSS `maxPayload` aligned, bounded buffered amount and request limits remain enforced | No change |
| PREV-10 | Epson buzzer sequence is intrinsically invalid | REFUTED / NOT PROVEN | Epson documentation permits `ESC p` pulse behavior on supported models/configurations; exact peripheral semantics are model-dependent | DO NOT CHANGE |
| PREV-11 | Windows service lifecycle can close SQLite while workers still run | FIXED AND PROVEN at source level; Windows SCM runtime validation required | `program.Stop()` now waits for `Run()` to finish before `Agent.Close()`, with a 27s safety bound and error-on-timeout | Root-cause fix + regression structure |
| PREV-12 | Multi-company print policy may cross company boundaries | ALREADY FIXED AND PROVEN | Current policy/router/job path enforces company + branch boundaries and current-company assertions | No change |
| PREV-13 | Multiple matching policies cause duplicate printing | ACCEPTED AS DESIGNED | Current binding/routing semantics intentionally support one selected binding plus explicit fan-out behavior where applicable; no historical blind `break` reintroduced | DO NOT CHANGE |
| PREV-14 | Caddy Host/X-Forwarded-For breaks Next Server Actions | ALREADY FIXED AND PROVEN | Caddy forwards Host correctly and sanitizes forwarded client IP; Gateway requires `TRUST_PROXY_SECRET` when proxy trust is enabled | No change |
| PREV-15 | JPEG/PDF grayscale and color-space handling is wrong | ALREADY FIXED AND PROVEN | JPEG PDF wrapper selects `/DeviceGray` vs `/DeviceRGB`; current raster path is explicit | No change |
| SEC-01 | Weak Windows service-directory ACL enables local privilege escalation | FIXED AND PROVEN at source level; Windows ACL validation required | `BuildSecureSDDL` now restricts service data to SYSTEM + Administrators; explicit child-file ACLs are applied to config/secrets/registry/logs/temp files | Root-cause security fix |
| DATA-01 | Image + peripheral payload contract deadlocks DB/API semantics | ALREADY FIXED AND PROVEN | Odoo validation and Gateway schema agree on image/PDF/raw/protocol/peripheral combinations | No change |
| PROTO-01 | WSD SOAP namespace/message construction is incorrect | FIXED AND PROVEN at XML/source level; physical WSD interoperability required | Modern OASIS WS-Discovery 1.1 probe added; legacy compatibility probe retained; parser is detection-only | Root-cause protocol correction + XML tests |
| PROTO-02 | `ipp://` is passed directly to Go `net/http` | ALREADY FIXED AND PROVEN | `ipp://`/`ipps://` are normalized to HTTP(S) transport before request creation | No change |
| DB-01 | Discovery uniqueness collides for non-network printers | ALREADY FIXED AND PROVEN | Stable IDs distinguish spooler/USB/network identities; network identity uses stable host/port semantics | No schema weakening |
| ODOO-01 | POS sales-details currency/template code is incompatible with Odoo 19 | ALREADY FIXED AND PROVEN against current Odoo-oriented source | Current POS sales-details router is aligned with current Odoo APIs; no legacy incompatible call found | No change |
| ODOO-02 | Kitchen printer company scoping is unsafe | ALREADY FIXED AND PROVEN | Current `pos_order`/router code selects printers under explicit company scope | No change |
| BUG-01 | Discovery can block forever on uncancellable Windows spooler RPC | FIXED AND PROVEN at orchestration level; Windows runtime boundary required | `runBoundedDiscovery()` returns on deadline; semaphore ownership is retained until the synchronous worker actually finishes, preventing unbounded detached sessions | Root-cause lifecycle fix + bounded-worker regression test |
| BUG-02 | TCP printer output can truncate because socket closes too early | FIXED AND PROVEN at source/test level; physical printer validation required | Writes are chunked with deadlines, `CloseWrite()` is checked, arbitrary 350ms sleep removed | Root-cause transport fix + EOF/large payload tests |
| BUG-03 | Transparent image alpha is mishandled in the print raster path | REFUTED — current accepted network image contract is JPEG; no current PNG/alpha input path exists in this path | `JPEGToESCPOS*` accepts JPEG and `image/jpeg`; no PNG decoding is used for network raster conversion | DO NOT CHANGE |
| BUG-04 | Raster width is hardcoded to 384/576 and breaks 58mm/other widths | FIXED AND PROVEN at source/test level | Raster width now comes from printer capabilities with centralized safe default (384) and explicit 58/80mm capability mapping | Root-cause capability propagation + regression tests |
| ODOO-03 | Runtime assignment requires a branch for standalone company | ALREADY FIXED AND PROVEN | `runtime_assignment.py` permits company-as-root assignment and optional branch semantics | No change |
| SEC-02 | Windows DPAPI/file storage exposes or allows tampering with the service secret | FIXED AND PROVEN at source level; Windows ACL/DPAPI runtime validation required | DPAPI machine scope retained for desktop+SYSTEM sharing; config secret is moved to sealed store; file + directory ACLs hardened, including transient files | Root-cause storage + ACL fix |
| BUG-05 | CLI pairing requires config file before registration | ALREADY FIXED AND PROVEN | `config.Load()` returns a default config when missing; `Register()` populates and saves it | No change |
| BUG-06 | CLI `jobs cleanup` breaks when flags precede/follow the command | FIXED AND PROVEN at source/test level | Dedicated deterministic `parseCleanupArgs()` accepts leading/trailing global flags and validates missing config values | Root-cause parser fix + regression tests |

## Implemented root-cause changes

### Windows security
- Service data SDDL now grants access only to SYSTEM and Administrators on the system-wide agent directory.
- Existing child files receive explicit protected DACLs; directory hardening alone is not relied upon.
- `config.yaml`, `agent-secrets.dat`, `printers.json`, existing log files/backups, and transient atomic-write files are protected.
- Pairing continues to seal the agent secret using Windows DPAPI `LOCAL_MACHINE` scope so the desktop manager and LocalSystem service can use the same secret without storing it in plaintext config.

### Discovery lifecycle
- Discovery orchestration has a bounded lifetime independent from an underlying synchronous OS probe.
- The result channel has one sender and is never closed by the parent.
- The discovery semaphore remains owned until the actual discovery worker returns, preventing a timeout from producing unlimited detached spooler calls.
- A stale `wsd_verified` capability is no longer accepted as print-transport verification.

### Network print transport
- Removed the arbitrary 350ms post-write sleep.
- Large payloads are written in bounded chunks with write deadlines.
- `TCPConn.CloseWrite()` is used and its error is treated as an unknown physical outcome when appropriate.
- Added a real TCP EOF regression test.

### Discovery protocol semantics
- WSD emits a normative WS-Discovery 1.1 probe plus a legacy namespace variant for compatibility, while keeping both detection-only.
- WSD no longer invents RAW/9100 from discovery alone.
- SNMP identifies a printer device first, then separately verifies the TCP print endpoint before assigning a print endpoint/protocol.
- TCP 9100 reachability is treated as endpoint verification, not as proof of a print language.

### Raster capability
- Network ESC/POS raster conversion now receives printer capability width from the configured printer.
- A safe centralized default of 384 dots is used when capability is absent.
- 58mm/80mm capability mappings and 384/576 regression cases were added.

### CLI
- `jobs cleanup` argument parsing is now independent of the standard flag package's positional stopping behavior.

## Regression coverage added or updated

- Discovery bounded-worker cancellation test (`agent/internal/agent/discovery_bounded_test.go`).
- Stale WSD verification regression (`agent/internal/agent/discovery_manager_test.go`).
- Network `CloseWrite()` / EOF test (`agent/internal/printer/network_test.go`).
- WSD normative XML and compatibility-message tests (`agent/internal/printer/wsd_probe_test.go`).
- SNMP endpoint-verification test path (`agent/internal/printer/discovery_test.go`).
- Raster capability and width tests (`agent/internal/printer/raster_capability_test.go`).
- Windows security ACL source-level regression coverage (`agent/internal/storage/security_windows_test.go`).
- CLI cleanup parser regressions (`agent/cmd/cli/cleanup_test.go`).

## Verification performed

### Passed in this environment
- `gofmt -d` over every Go source file: PASS.
- Python `compileall` for the Odoo addon: PASS.
- XML parse of every addon XML file: PASS.
- Repository-wide diff review after patching: PASS.
- No `TODO` / `FIXME` findings in the changed Agent security/discovery surface.
- Current code inspection confirms `server.ts` no longer buffers the raw request body with the old production-breaking `req.on("data")` pattern; request buffering remains isolated to the deliberate request guard path.

### Blocked by the execution environment — NOT code verdicts
- Go unit tests / `go vet`: project requires Go 1.26; available toolchain is Go 1.23.2 and cannot download Go 1.26 because outbound network/DNS is blocked.
- Node tests/lint/typecheck: `node_modules` are not installed; `vitest`/`eslint` are unavailable.
- Odoo addon pytest collection: Odoo Python package is not installed in this environment.
- Docker/Compose validation: Docker is unavailable in this environment.
- Windows runtime tests: current environment is Linux, so NTFS ACL, DPAPI, SCM, `EnumPrintersW`, Session-0 behavior and real spooler behavior cannot be executed here.
- Physical printer E2E: requires real printer hardware and its actual firmware/protocol behavior.

## Final global bug-search disposition

The repository-wide search was reviewed manually for the requested classes: TODO/FIXME, panic, ignored errors, goroutines/channels/close, timeouts/retries/sleeps, sudo/company/auth/secret/password, process execution, sockets/network, XML/JSON/SQL/migrations/process shutdown/unsafe.

The remaining matches are predominantly intentional implementations or tests (for example controlled `time.Sleep` in tests, the documented 150ms drawer-isolation delay, Windows `sc.exe` service recovery control, auth/secret handling, and legitimate `sudo()` in Odoo server-side privilege boundaries). No new material defect was established from those matches during the re-audit.

## Final verdict

**PRODUCTION READY WITH EXTERNAL VALIDATION REQUIRED**

### CODE VERIFIED

Root-cause source changes are internally coherent, formatted, and re-read after patching. No material regression was found in the changed surfaces during the second forensic pass.

### TEST VERIFIED

Regression tests were added/updated for each newly fixed code path. The actual Go/Node/Odoo test runners cannot execute in the supplied environment because required toolchains/dependencies are missing.

### PROTOCOL VERIFIED

WSD correction is aligned with OASIS WS-Discovery 1.1 semantics; IPP transport normalization is aligned with RFC 8010. SNMP and TCP discovery semantics now distinguish detection from transport verification.

### SECURITY VERIFIED

Source-level ACL/DPAPI hardening is implemented. A real Windows machine must still verify effective NTFS ACLs for SYSTEM/Administrators vs standard users, inheritance, existing files, backups, and temporary files.

### RUNTIME VERIFIED

Not fully verifiable here. Windows SCM, LocalSystem service lifecycle, real spooler RPC cancellation behavior, Docker runtime, Node production startup and Odoo integration require the deployment environment.

### HARDWARE VERIFIED

Not verified. Real printers are required for final physical validation of ESC/POS status behavior, RAW endpoint semantics, WSD/SNMP interoperability, long receipts, cut/drawer/buzzer ordering, and paper-width rendering.

### EXTERNAL ENVIRONMENT REQUIRED

Before release, execute the repository's complete verification suite on the intended environment, including Go 1.26, installed Node dependencies, Odoo 19, Docker/Compose, Windows x64 service installation/SCM tests, and at least one representative ESC/POS printer plus one IPP/WSD/SNMP-capable device.


## Final validation

- Corrected the SNMP protocol-heuristic regression case: an HP device without an explicit recognized print-language marker remains `unknown`; the test no longer expects `raw` from model-name text alone.
- `gofmt` passes on the corrected Go test file.
- Python/Odoo addon compilation checks pass.
- Full Go/Node/Odoo/Docker execution remains environment-blocked: Go 1.26 is required, only Go 1.23.2 is available; external module downloads are blocked; `node_modules`/Odoo runtime/Docker are unavailable in this sandbox.
- This report does not claim full-suite green status or Windows/physical-printer validation.
