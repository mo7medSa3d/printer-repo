# Third-Party Notices

## PDFium (embedded PDF renderer, Windows agent)

- What: `pdfium.dll` shipped beside `OdooPrintAgent.exe`
  (`agent/third_party/pdfium/win-x64/pdfium.dll` in source).
- Upstream: https://pdfium.googlesource.com/pdfium, packaged by
  https://github.com/bblanchon/pdfium-binaries, tag `chromium/8044`
  (PDFium 155.0.8044.0, no-V8 build).
- License: BSD 3-Clause, © 2014 The PDFium Authors.
  Full text: `agent/third_party/pdfium/LICENSE.PDFium-third-party`.
- Packaging notices: `agent/third_party/pdfium/LICENSE.pdfium`
  (Benoit Blanchon build scripts).

## PDFium build tooling notices

- Additional third-party licenses bundled with the upstream binary
  distribution (libopenjpeg, Abseil) are listed upstream; the agent links
  only the PDFium shared library and does not redistribute those
  sources. See `docs/PDF_RENDERING.md` for provenance and SHAs.
