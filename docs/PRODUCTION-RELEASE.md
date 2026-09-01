# Production Hardening & Windows Release Runbook

Summary of the production-readiness pass and the exact release procedure.

## What changed (hardening pass)

### Desktop app (Tauri 2.x, `src-tauri/` + `src/desktop/`)

| # | Issue | Fix |
|---|-------|-----|
| 1 | `tauri.conf.json` pointed `bundle.windows.nsis.template` at a custom NSIS template that does not exist → NSIS bundling would fail | Removed; Tauri's default NSIS template used (`installMode: perMachine`, Start Menu folder, desktop shortcut, Add/Remove Programs uninstaller) |
| 2 | Tray commands `Restart Agent` / section navigation emitted events nothing listened to → dead menu items | Frontend now listens (`tray:restart_agent`, `tray:navigate`); tray menu reduced to items that map to real UI sections; navigation happens inside the WebView (no `eval` permission needed) |
| 3 | UI-thread blocking: pairing/start/stop/restart/service-control ran synchronously on Tauri's main thread (pairing does a 15s HTTP round-trip) | All long-running commands are now `async` and run on `spawn_blocking`; instant validation still returns immediately |
| 4 | Release builds have no console (`windows_subsystem`) → panics were invisible | Panic hook writes `PANIC …` (location + payload) into the log file |
| 5 | Log file grew unbounded; no rotation | Rotation at 5 MiB, keeping 3 rotated copies (manager log and Go agent log) |
| 6 | Two competing settings stores (Rust `settings.json` in ProgramData + `@tauri-apps/plugin-store` in %APPDATA%) could diverge | Single source of truth: Rust-owned `settings.json`. Removed `tauri-plugin-store`, `@tauri-apps/plugin-store` dependency and `store:default` capability (least-privilege: `core:default` only) |
| 7 | Version displayed in the UI was hardcoded | UI reads `get_app_version` (derived from `Cargo.toml`) |
| 8 | `get_runtime_paths` returned an untyped 4-tuple | Typed `RuntimePaths` struct over JSON |
| 9 | Frontend `fetch /api/health` had no timeout → "busy" could hang forever | 8s `AbortController` timeout with a clear error message |
| 10 | IPC leak: cleanup of tray event listeners not guaranteed | Listeners unsubscribed on unmount; UI↔IPC split into `src/desktop/lib/ipc.ts` (typed boundary, SOLID) |

### Go agent (`agent/`)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Heartbeat probed each printer's TCP status **sequentially on the main select loop** (2s dial timeout × N printers) → stalled heartbeat/poll for offline printers | Probes run concurrently; heartbeat/poll are non-reentrant (`TryLock`) and dispatched off the select loop |
| 2 | Unbounded goroutine fan-out: every WS message/poll batch spawned `go processJob` → memory exhaustion on backlog bursts | Bounded executor: ≤64 accepted jobs (drop-and-redeliver beyond that, gateway reclaims), ≤8 executing at once, id-dedup while in flight |
| 3 | SQLite queue handle never closed on shutdown; jobs could be killed mid-write | `Stop()` cancels → drains in-flight jobs (≤25s) → closes the queue once; shutdown gate makes `dispatchJob`/`waitForJobs` race-free (WaitGroup `Add` before `Wait`) |
| 4 | `config.yaml` saved by truncate-and-write → crash mid-write could strand the pairing secret; secret file was 0644 | Atomic write: temp file (0600) + fsync + rename; restrictive perms asserted on the final path |
| 5 | `internal/storage` — dead, misleading DPAPI/FileStore stubs that reported success without storing anything | ~~Package removed~~ → superseded by `main` (another branch revived it into a real cross-platform secure store: platform-agnostic `secure.go`, DPAPI on Windows, posix fallback, `secure_test.go`). Our deletion was dropped during the `origin/main` merge; the revived package is kept. Full real wiring to the agent config remains documented future work — package is currently unused by imports. |
| 6 | WS reconnect had fixed 5s→60s backoff | Jittered backoff (50–100% of step) to avoid reconnect herds |
| 7 | Release binaries carried debug info / build paths | `-trimpath -ldflags "-s -w"` in CI, Makefile `release` target, build script |
| — | New executor has no test coverage | `agent/internal/agent/dispatch_test.go` (dedupe, drain, post-shutdown rejection), runs in CI with `-race` |

### Config, deps, pipeline

- `package.json`: real name/version/license/engines (`node >= 22`); removed unused `dotenv`, `sql.js`, `@tauri-apps/plugin-store`; lockfile regenerated.
- `drizzle.config.json` (hardcoded local DB URL) → `drizzle.config.ts` reading `DATABASE_URL`.
- `.env.example`: production annotations (secret generation, hash vs plaintext, client-PC overrides).
- `LICENSE` (MIT) added — matches the license already declared in `Cargo.toml`.
- CI (`build-windows.yml`): Node from `.nvmrc` (22), Go `stable`, `go vet`, `go test -race`, release ldflags.
- `Makefile`: `release`, `vet`; corrected the CGO cross-compile note (go-sqlite3 needs CGO — Windows EXEs must be built on Windows/mingw, never `CGO_ENABLED=0`).

## What changed (round 2 — full re-read sweep)

A second full read of every file in the repo found the following; all fixes verified
by typecheck / lint / vitest / Next build / desktop build / runtime smoke test.

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **Critical** | `/dashboard` server component rendered agents (including `agents.secret` hash), printers, and job data **with no authentication** — the management APIs were guarded, the page itself was not | `src/app/dashboard/page.tsx` now verifies the `mgr_session` cookie (HMAC + server-side session row) and `redirect("/login")` otherwise; the agent payload is selected **without** `secret` so the credential hash never reaches the client bundle |
| 2 | **Critical** | Server actions (`createAgent`, `createPrintJob`, `createTestPrintJob`, `deleteAgent`) were public HTTP endpoints — `use server` ≠ authenticated. Anyone could forge POSTs to create/delete agents and enqueue physical print jobs | Every action now runs `requireManager()` (cookie → `verifyManagerToken` → session-row check) before touching the DB (`src/app/actions.ts`) |
| 3 | **Major** | WS-pushed jobs were never claimed: the PATCH status machine forbids transitions out of `queued`, so a WS-connected agent that *received* a pushed job got 409 on every status update; jobs churned into `expired`/`failed` despite successful printing | New `pushJobToAgentWithClaim` (`src/server/ws.ts`) — after a successful WS delivery the job is atomically claimed (`UPDATE … SET status='claimed' WHERE id=? AND status='queued'`, races collapse to 0-row no-ops). Used by all three creation paths (Odoo `POST /api/print/jobs`, manager test-print, `createPrintJob` action). Failed push leaves the job `queued` for the poll fallback. **Superseded 2026-09:** `pushJobToAgentWithClaim` was replaced by `claimAndPushJobToAgent`, which claims the job in a transaction (`FOR UPDATE SKIP LOCKED`) *before* the WS send and releases the claim under the same job id when the send fails — see API.md §5 |
| 4 | Moderate | `GET /api/jobs` filtered **after** `LIMIT` (in memory) — matches older than the window silently disappeared from filtered results | Filters are now a SQL `WHERE` (`and(eq(…), …)`) applied before the limit; invalid `status` filter → `400` using `isJobStatus` |
| 5 | Moderate | Base64 validation comment claimed a round-trip strictness check that didn't exist. Node's `Buffer.from` tolerates invalid/unpadded base64 while the Go agent's `base64.StdEncoding` is strict → the gateway could accept a payload the agent later rejects | `payload.data` refine now requires canonical round-trip (`decoded.toString("base64") === s`), keeping the two validators in lockstep; regression tests added (`tests/payload.test.ts`) |
| 6 | Minor | Heartbeat accepted arbitrary `agents.status` strings from the authenticated agent | Clamped to `{online, offline}` (default `online`) |
| 7 | Minor | Dead code: `hashPasswordScrypt` helper (never called), dead `agents`/`setAgents` state in the dashboard client | Removed |

## Build the Windows installer

Prerequisites on the build host: Windows 10/11, Node ≥ 22 (nvm: `nvm use`), Go ≥ 1.21,
Rust stable (`rustup`), tauri-cli (`cargo install tauri-cli --version "^2" --locked`).

```powershell
git clone <repo>; cd printer-repo
pwsh -File scripts/build-windows-installer.ps1
```

Artifacts:

```text
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\Odoo Print Manager_1.0.0_x64-setup.exe
src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\Odoo Print Manager_1.0.0_x64_en-US.msi
```

The installer is fully self-contained (frontend + agent + CLI embedded; WebView2
bootstrapped at install time). Shortcuts (Start Menu + desktop) and the
uninstaller entry are generated automatically.

Then on a clean Windows VM:

```powershell
.\\scripts\\smoke-test-windows.ps1
# optional service layout (elevated):
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service install
& "C:\Program Files\Odoo Print Manager\resources\OdooPrintAgent.exe" -service start
```

## What changed (round 3 — generic Odoo printing + Direct USB + IPP)

All verified by `py_compile` + `xmllint` + `typecheck/lint/vitest/Next build/desktop build/go vet` on this host; hardware IPP/USB still `REQUIRES REAL WINDOWS/PRINTER`.

| # | Area | Change |
|---|------|--------|
| 1 | Odoo generic printing | `odoo_addons/print_gateway/models/report_mapping.py` (new 8-field mapping, priority `report_id > xml_id > report_name > model_name`) + `ir_actions_report.py` `report_action` override now intercepts **standard Odoo Print** (not custom button) → `_determine_branch/destination/document_type` → `_render_qweb_pdf` → `raw` base64 PDF → `branch.create_print_job` with `odoo_model/record_id/report_xml_id/report_name` |
| 2 | Odoo print job tracking | `print_job.py` added `odoo_model, odoo_record_id, report_xml_id, report_name, report_id (Many2one ir.actions.report)` + views show `Odoo Report` group, tree shows `odoo_model/report_xml_id` |
| 3 | Odoo branch | `branch.py:171` `create_print_job` now 8-args `(destination_id, document_type, payload, odoo_model, odoo_record_id, report_xml_id, report_name, report_id)` stores metadata, `report_id` resolved via `env.ref` |
| 4 | Odoo Sale Order | `sale_order_views.xml` header `Print via Gateway` button **removed** (now `ir.actions.server` deprecated), `sale_order.py:14` now delegates to `report_action` if gateway-enabled else legacy ESC/POS, single path is standard Print |
| 5 | Odoo configuration UI | `views/report_mapping_views.xml` + `views/ir_actions_report_views.xml` (forms inherit `base.view_report_form` with `print_gateway_enabled` toggle) + `data/report_mappings.xml` 8 defaults `noupdate=1` for `sale→order, account→invoice, stock→delivery/picking, purchase→purchase_order, pos→receipt` + `security` `report_mapping` system/user + `__manifest__.py` 14 data + `menu.xml` Report Mappings |
| 6 | Agent Direct USB | `usb_windows.go` `SetupDi` `GUID_DEVINTERFACE_USBPRINT` path map + `USBPrinter.Print` `CreateFile(\\?\usb#...)` `WriteFile` 8192 chunk loop, `factory.go` `usb` without spooler now returns `USBPrinter` instead of error, `usb_other.go` non-Windows stub simulates `/tmp/` file for CI |
| 7 | Agent IPP | `ipp.go` `IPPPrinter` `normalizeIPPURL` handles bare `host:port` → `http://host:port/ipp/print`, `buildIPPPrintJob`/`Get-Printer-Attributes` binary 2.0, `Print` `POST application/ipp` `httptest` mock, `factory.go` `network:ipp` + `ipp/ipps` type now creates `IPPPrinter`, `config.go` allows `ipp/ipps` protocol |
| 8 | Agent discovery hardening | `spooler_windows.go` correct `PRINTER_INFO_2W` `unsafe.Sizeof` + `mapWindowsStatus` + `classify.go` pure, `network_discovery.go` 9100 + `ipp_discovery.go` 631 + `discoverUSBPrinters` pathMap, `discovery.go` 6 sources + `seen` + `NetworkAddress:Port`/`USB` dedup + `mergeDeviceInfo` + `DiscoverQuick` sync + async full 2s, `stable_id.go` `ipp://` URL host:port aware |
| 9 | Gateway IPP/USB | `heartbeat/route.ts` `VALID_CONNECTION_TYPES` `ipp,ipps`, `VALID_PROTOCOLS` `ipps`, `printers/route.ts` `ipp/ipps` + `validateNetworkConfig` URL, `routing.ts` `validatePayloadForPrinter` now allows `raw/escpos` → `ipp` via `application/octet-stream` |
| 10 | CLI | `cli/main.go` `printers add` now `--printer-type --vid --pid --serial --enabled --capabilities JSON`, `helpers.go` `addPrinterHelper` 11 fields, table shows `ENABLED, network, usb vid/pid, caps, diagnostic`, `discover` now `ipp` too |
| 11 | Tests | `hardening_test.go` 12, `ipp_test.go` 5 (`httptest` `application/ipp`), `discovery_test.go` fixed to expect `usb/ipp` success, `tests/test_report_gateway.py` 12 Odoo tests A-L (mocked `requests.post` + `_render_qweb_pdf`) |

## Verification gate status (this host)

| Gate | Result |
|------|--------|
| `python3 -m py_compile odoo_addons/print_gateway/models/*.py` + `xmllint --noout views/*.xml data/*.xml` | ✅ PASS (this session, after fixes) |
| `npm run typecheck` | ✅ PASS |
| `npm run lint` | ✅ PASS (after `&quot;` + `queueMicrotask` fix) |
| `npm test` (vitest) | ✅ 32 pass, 1 skipped (was 13, now 32 with `hardening` + `ipp`) |
| `npm run build` (Next.js production) | ✅ PASS (24 routes) |
| `npm run desktop:vite:build` | ✅ PASS (43KB css + 208KB js, 891 lines modern UI) |
| Runtime smoke: `/dashboard` while unauthenticated → 307 `/login`; `/api/jobs` unauth → 401 | ✅ PASS |
| Go/Rust syntax validation (tree-sitter parse of every `.go`/`.rs`) | ✅ PASS |
| `go vet` / `GOOS=windows go vet` | ✅ PASS (fixed `spoolerContains` + `unsafe.Add`) |
| `go test -race ./...` | ✅ 8 pkgs ok (printer 4.9s) |
| `odoo-bin --test-enable --test-tags=print_gateway` | 🧪 Not run (no Odoo DB on this host) — `tests/test_report_gateway.py` 12 mocked tests exist but require `sale,account,stock,purchase` DB |
| `cargo tauri build` / Real Windows install / real printer | Per `docs/VERIFICATION.md` (REQUIRES REAL WINDOWS/PRINTER) |

Known, accepted remnant of #3 (documented in `src/server/ws.ts`): a very fast agent
can PATCH `printing` in the millisecond window between WS dispatch and the claim
UPDATE landing; that single progress tick may be 409-rejected, but the terminal
`success`/`failed` PATCH always lands against the claimed row. A job created while
no agent socket is open stays `queued` until the agent's poll fallback claims it
(same as before), and an agent that never reconnects sees the job expire at its TTL
(≤1h default) — unchanged from the poll-only design.
