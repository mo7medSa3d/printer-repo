# Embedded PDFium Agent Verification — 2026-09-11

## Scope

This verification covers the local repository snapshot supplied for this task. The requested work is to remove the external PDF application dependency, integrate embedded PDF rendering, preserve the Windows printer architecture, and audit the Go dependency graph.

## 1. PDF architecture

- Renderer: `github.com/klippa-app/go-pdfium` v1.19.8, WebAssembly backend.
- Runtime: `github.com/tetratelabs/wazero` v1.12.0.
- Embedding: go-pdfium embeds its PDFium WASM module into the Agent binary; no PDFium DLL is expected at runtime.
- Printer integration: one rendered page at a time → in-place RGBA-to-BGRX conversion → Windows GDI `HDC` → printer driver/spooler.
- Concurrency: one PDFium worker and a single PDF print mutex; no unbounded PDF renderer goroutines.
- Limits: existing 5 MiB payload cap, 500 pages, 16,000,000 rendered pixels per page.
- Filesystem: Wazero receives an explicit empty `FSConfig` so the renderer does not inherit a host working-directory filesystem mount.
- Page fitting: printer `HORZRES`/`VERTRES`, `PHYSICALOFFSETX/Y`, and `LOGPIXELSX/Y` are read; PDFium preserves page aspect ratio rather than hard-coding A4/Letter.

The exact final executable/package size and real RAM profile are intentionally **not fabricated** because this environment cannot perform the required Go 1.26 Windows build. The configured 16 MP cap corresponds to at most 64,000,000 bytes for one 32-bit page bitmap before renderer/runtime overhead.

## 2. External PDF dependency

Removed from the production path:

- SumatraPDF discovery and prerequisite behavior.
- `ShellExecuteExW` / `printto` PDF handler execution.
- `pdf_print_command` / `PDFPrintCommand` configuration.
- Agent startup registration for an external PDF helper.
- Documentation that required an external PDF application.

No optional external PDF fallback remains. RAW and ESC/POS backends remain separate and unchanged in architecture.

## 3. Go dependency audit

| Module | Before | After | Classification / reason |
|---|---|---|---|
| `github.com/gorilla/websocket` | 1.5.3 | 1.5.3 | Retained; directly imported by Agent WebSocket code |
| `github.com/kardianos/service` | 1.3.0 | 1.3.0 | Retained; directly imported for Windows service lifecycle |
| `github.com/mattn/go-sqlite3` | 1.14.50 | 1.14.50 | Retained; directly imported; no unverified upgrade |
| `gopkg.in/yaml.v3` | 3.0.1 | 3.0.1 | Retained; directly imported configuration parser |
| `golang.org/x/sys` | 0.47.0 | 0.47.0 | Retained; Windows APIs use it; no unverified upgrade |
| `github.com/klippa-app/go-pdfium` | absent | 1.19.8 | Added direct runtime dependency for embedded PDF rendering |
| `github.com/tetratelabs/wazero` | absent | 1.12.0 | Added as indirect runtime dependency used by go-pdfium WebAssembly backend |
| `github.com/google/uuid` | absent | 1.6.0 | Required transitively by go-pdfium |
| `github.com/jolestar/go-commons-pool/v2` | absent | 2.1.2 | Required transitively by go-pdfium |
| `golang.org/x/net` | absent | 0.57.0 | Required transitively by go-pdfium |
| `golang.org/x/text` | absent | 0.40.0 | Required transitively by go-pdfium |
| `github.com/cenkalti/backoff` | existing | retained in manifest for now | No direct import found; full module-graph cleanup requires Go 1.26 module resolution |
| `github.com/miekg/dns` | existing | retained in manifest for now | No direct import found; retained pending reproducible `go mod tidy` |
| `golang.org/x/crypto` | existing | removed from manifest | No Agent source import and no confirmed need in the selected module graph |

The dependency set was not blindly upgraded. Current upstream checks confirm go-pdfium v1.19.8 is a tagged stable v1 release and Wazero v1.12.0 is its referenced WebAssembly runtime. Existing stable Agent dependencies were not changed merely for version churn.

## 4. Security / vulnerability scan

`govulncheck` could not be executed in the supplied environment because the local Go installation is 1.23.2 while the Agent module requires Go 1.26, and the environment cannot resolve the Go module proxy for toolchain/module downloads. The repository security workflow now pins the latest `golang/vuln` release currently exposed by GitHub (`v1.1.4`). Therefore **no clean `govulncheck` result is claimed**.

## 5. Verification commands

| Check | Result | Evidence / limitation |
|---|---|---|
| `go mod tidy` | NOT RUN TO SUCCESS | Local Go 1.23.2 cannot satisfy `go 1.26`; module downloads are unavailable |
| `go test ./...` | NOT RUN TO SUCCESS | Same Go/toolchain limitation |
| `go vet ./...` | NOT RUN TO SUCCESS | Same Go/toolchain limitation |
| `go test -race ./...` | NOT RUN TO SUCCESS | Same Go/toolchain limitation |
| `govulncheck ./...` | NOT RUN | Tool/module download path unavailable in this environment |
| Windows x64 Agent build | NOT RUN | No Windows/Go 1.26 Windows toolchain available here |
| Installer build/package | NOT RUN | Requires Windows build toolchain and Tauri bundling environment |
| Physical printer | NOT VERIFIED | Requires real Windows PC + real printer |

No verification result above is represented as passing when it was not actually run.

## 6. Physical printing verification

`NOT PHYSICALLY VERIFIED — REQUIRES REAL WINDOWS PRINTER`

The repository contains a Windows-only PDFium/GDI smoke test and the manual end-to-end procedure remains in `WINDOWS_PHYSICAL_E2E.md`.

## 7. Remaining risks

1. The exact Go 1.26 module resolution and final `go.sum` cannot be regenerated in this Linux/Go 1.23.2 environment. The supplied checksum file contains the known transitive hashes but requires `go mod tidy` under Go 1.26 to be canonical.
2. Real Windows Session 0 behavior and driver-specific GDI output remain hardware/Windows-environment verification steps.
3. The 16 MP bitmap cap is intentionally a resource guard; operators should verify output quality on high-DPI printers during physical E2E.

## 8. Changed files

- `agent/internal/printer/pdf.go`
- `agent/internal/printer/pdf_windows.go`
- `agent/internal/printer/pdf_other.go`
- `agent/internal/printer/pdf_test.go`
- `agent/internal/printer/pdf_windows_test.go`
- `agent/internal/config/config.go`
- `agent/internal/agent/agent.go`
- `agent/configs/config.yaml.example`
- `agent/go.mod`
- `agent/go.sum`
- `.github/workflows/security-supply-chain.yml`
- `agent/EMBEDDED_PDFIUM.md`
- `agent/EMBEDDED_PDFIUM_VERIFICATION_2026-09-11.md`
- `INSTALLATION.md`
- `docs/AGENT.md`
- `docs/DEPLOYMENT.md`
- `docs/DEVELOPMENT.md`
- `PRINTERS.md`
- `WINDOWS_PHYSICAL_E2E.md`

Historical audit reports may still contain references to the previous renderer because they document the prior state; operational code/configuration/docs no longer depend on it.
