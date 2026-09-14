# Phase 14 - Print Payload Contract

## Verification
- Investigated `src/lib/payload.ts`, `src/lib/routing.ts`, and `agent/internal/printer/document.go`.
- Validated payload bounds:
  - Sizes strictly limited to 5MB (`MAX_PAYLOAD_BYTES`).
  - Image payloads restricted to JPEG validation.
  - PDF restricted to `%PDF-` signature.
  - RAW payloads require explicit protocols (`escpos`, `zpl`, `tspl`, `raw`). No guessing.
- Verified physical capabilities logic (`agent/internal/printer/network.go` and `src/lib/routing.ts`) enforce these bounds uniformly across Gateway and Go Agent.

## Findings
- Payloads and format validation are uniformly managed.
- Declared execution boundaries perfectly align with product expectations.
- Odoo payload handling checks the capabilities declared before scheduling the jobs via Postgres.
- Test suites cover edge capabilities cases such as unknown+network rejecting jobs gracefully.

## Actionable
- Payload contract logic complies fully. Proceeding to Phase 15.
