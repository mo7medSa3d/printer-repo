# Third-party notices — embedded PDF printing

## Klippa go-pdfium

The Agent uses `github.com/klippa-app/go-pdfium` v1.19.8. The upstream project is licensed under the MIT License.

Copyright (c) 2022 Klippa App BV.

Upstream source: https://github.com/klippa-app/go-pdfium/tree/v1.19.8

## Google PDFium

The go-pdfium WebAssembly payload contains the PDFium engine from Google's PDFium project. go-pdfium documents PDFium as Apache License 2.0.

Upstream project: https://pdfium.googlesource.com/pdfium/

## Wazero

The embedded WebAssembly runtime is `github.com/tetratelabs/wazero` v1.12.0, licensed under Apache License 2.0.

Upstream source: https://github.com/tetratelabs/wazero/tree/v1.12.0

Release packaging must preserve the upstream license/notice texts required by the selected versions. The Agent does not download these components at runtime.
