# Vendored PDFium runtime (Windows x64 + Linux x64 build/test)

## What and why

The Windows agent renders PDFs with an **embedded PDFium** library instead of
launching an external PDF application. PDFium is the BSD-3-licensed PDF engine
behind Chromium, and its C API explicitly supports printing scenarios.

Binding strategy (deliberate): **minimal direct CGO** in
`agent/internal/pdfium/` (~12 PDFium C functions), **zero new Go modules**.
An existing maintained Go binding was evaluated and rejected: it drags a
plugin/gRPC/wasm module universe into a Windows service whose dependency
graph must stay auditable (see `docs/PDF_RENDERING.md`).

## Provenance (pinned, reproducible)

- Upstream: https://github.com/bblanchon/pdfium-binaries
- Tag: `chromium/8044` (PDFium 155.0.8044.0, `MAJOR=155 MINOR=0 BUILD=8044`)
- Variant: **no-V8** builds (`pdfium-win-x64.tgz`, `pdfium-linux-x64.tgz`).
  Without V8, embedded JavaScript in PDFs cannot execute — a smaller,
  safer renderer for unattended service use.
- SHA-256 of the downloaded archives:
  - `pdfium-win-x64.tgz`: `78a17d9a5f14467631c26a3ac8741b27a0471ecc05bd6a119b523598160a0537`
  - `pdfium-linux-x64.tgz`: `eb142f416aed3a72fc5a02dbd5884868a16cb99dc0cf53e6bdd64afbf67b05f4`
- License: `LICENSE.pdfium` (BSD-3, Google et al.). Keep it with any release.

## Layout

```text
agent/third_party/pdfium/
  README.md            this file
  LICENSE.pdfium       PDFium BSD-3 license (ship with releases)
  include/fpdfview.h   C headers used by the cgo shim (build time only)
  win-x64/
    pdfium.dll         SHIPPED: copied next to OdooPrintAgent.exe by the installer
    pdfium.dll.lib     MSVC import library (build time only, never shipped)
  linux-x64/
    libpdfium.so       BUILD/TEST ONLY on Linux (unit tests). Never shipped.
```

`linux-x64/` exists so `go build ./...` and `go test ./...` work on Linux
without extra setup. The Windows installer ships **only** `pdfium.dll`.

## Re-provisioning / upgrades

```sh
sh agent/third_party/pdfium/fetch.sh [chromium/NNNN]
```

Verifies SHA-256 before extracting. After upgrading, update the SHAs in
`fetch.sh`, this README, and `docs/PDF_RENDERING.md`, then run the full
verification matrix (`go test -race ./...` on Linux and Windows).

## Runtime loading (security)

- Windows resolves `pdfium.dll` from the application directory (where the
  installer places it next to the agent binary). The agent additionally
  constrains DLL loading to the application directory
  (`SetDefaultDllDirectories`), so a hostile working directory can never
  inject a rogue renderer. See `internal/pdfium`.
- No renderer is ever downloaded, installed, or updated at runtime.
