# Embedded PDFium printing

The Windows Agent prints PDFs without an installed desktop PDF application.

- Renderer: `github.com/klippa-app/go-pdfium` v1.19.8 in WebAssembly mode.
- Runtime: `github.com/tetratelabs/wazero` v1.12.0.
- PDFium delivery: the go-pdfium PDFium WebAssembly module is embedded in the Go binary; no PDFium DLL, native PDF runtime, browser engine, or installer-time download is required.
- Printing path: PDFium renders one page to RGBA, the Agent converts it in place to top-down 32-bit BGRX, and Windows GDI submits it to the selected printer HDC.
- Concurrency: one PDFium worker and one serialized PDF print at a time.
- Limits: existing 5 MiB payload cap, 500 pages maximum, 16,000,000 rendered pixels maximum per page.
- Security: the PDFium Wazero instance receives an isolated filesystem configuration rather than a host working-directory mount.

## Service behavior

The production path does not require an interactive desktop session. It does not invoke `ShellExecute`, `printto`, file associations, or an external process. The design is intended for Windows Service Session 0. This repository was developed in an environment without Windows or a physical printer, so Session 0 and physical output remain verification steps for Windows CI/hardware.

## Packaging

Because PDFium WebAssembly is embedded in the Go module, the existing installer does not need a separate PDFium DLL resource. The release executable contains the renderer runtime. Exact final executable/package size must be measured from the Windows release artifact; it is not fabricated here because this environment cannot produce the required Go 1.26 Windows build.

## Licensing

`go-pdfium` is MIT-licensed. Its embedded PDFium engine is from Google's PDFium project and is licensed under Apache License 2.0. Preserve the upstream notices shipped with the selected dependency and review the module's current NOTICE/license files as part of release preparation.
