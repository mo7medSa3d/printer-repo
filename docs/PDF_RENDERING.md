# Embedded PDF rendering (Windows agent)

## Decision

The Windows agent renders PDFs with **PDFium 155.0.8044.0** (no-V8 build)
embedded beside the agent binary. No external PDF application (SumatraPDF,
Adobe Reader, Edge, Chrome, Foxit) is installed, launched, or required.

Binding strategy: **minimal direct CGO** in `agent/internal/pdfium`
(~12 PDFium C functions, headers in
`agent/third_party/pdfium/include/fpdfview.h`), **zero new Go modules**.
A maintained third-party Go binding was evaluated and rejected: it pulls a
plugin/gRPC/wasm module universe into a Windows service whose dependency
graph must stay auditable.

Provenance: <https://github.com/bblanchon/pdfium-binaries>,
tag `chromium/8044` (see `agent/third_party/pdfium/README.md` for SHAs).
License: BSD-3 (see `THIRD_PARTY_NOTICES.md`).

## Pipeline

```text
job payload (PDF bytes)
  → ValidatePDF (header/trailer, maxPrintBytes ceiling)
  → pdfium.Open (parse; password/unsupported → deterministic failure)
  → per page: PageSizePoints → selectRenderDPI (printer DPI, pixel budget)
  → GDI StartDoc  ← submission starts here; everything after is UNKNOWN on failure
  → per page: RenderPageBGRA (one transient buffer) → StartPage →
    StretchDIBits (aspect-fit, centered, never cropped) → EndPage
  → EndDoc → structured result
```

- Page-by-page: peak memory is exactly one page buffer (Letter at 300 DPI
  ≈ 34 MiB transient), released before the blit result is even checked.
- Buffers are never reused across pages (fresh allocation per render keeps
  failure cleanup trivially leak-free).
- Rotation: PDFium applies embedded `/Rotate` itself; page dimensions are
  read post-rotation.
- Rendering flags: `FPDF_ANNOT` (annotations must print). No smoothing
  overrides: PDFium defaults are the correct print trade-off.
- Concurrency: all PDFium calls serialize on a package mutex (process-global
  C state); the agent executor (8 concurrent jobs) bounds overall load, so
  no unbounded goroutines can arise from rendering.
- Cancellation is honored before submission (plain error) and between pages
  (unknown outcome, since earlier pages may have spooled).

## Windows printing path

Pages are painted with `StretchDIBits` (32-bit BGRA, top-down) onto a
printer device context (`CreateDCW` on the spooler name — no window, no
dialog, fully Session-0 safe), scaled to **fit** the printable area
(`HORZRES`/`VERTRES`) preserving aspect ratio and centered. Content is
never cropped and never stretched non-uniformly. A failed spool open is a
deterministic pre-print error; anything after `StartDoc` is unknown
outcome (see `agent/internal/printer/outcome.go` semantics).

## Resource limits (all documented in code)

| Limit | Value | Where |
|---|---|---|
| Document bytes | 8 MiB | `pdfium.MaxDocumentBytes` (= job pipeline ceiling) |
| Page count | 1000 | `pdfium.MaxPages` |
| Render buffer | 16 MP (~64 MiB transient) | `pdfium.MaxRenderPixels` |
| DPI | 72–600, auto-step-down | `selectRenderDPI` |
| Submission budget | 120 s + caller cancel | `PrintPDF` |

These never reject legitimate customer PDFs below the existing 8 MiB job
ceiling; oversized pages step DPI down before refusing.

## Session 0 / service compatibility

No GUI calls, no `ShellExecute`, no file associations, no interactive
desktop session. The renderer DLL resolves from the application directory
(where the installer places it); the agent additionally constrains DLL
resolution to app-dir + System32 at startup (`printer.HardenDllSearch`).

## Troubleshooting

- `PDF is encrypted or password-protected` → remove the password before sending.
- `printerDC/CreateDC failed` → spooler name wrong or spooler stopped; check `services.msc` → Print Spooler.
- `page N at M DPI needs P pixels` → lower the source page size; DPI auto-steps down first.
- `resources\pdfium.dll` missing beside the agent → reinstall the bundle; the smoke test asserts its presence.
