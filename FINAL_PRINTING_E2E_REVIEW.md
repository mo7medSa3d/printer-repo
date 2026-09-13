# Final Printing E2E Review

## Static protocol matrix

| Protocol / path | Code path found | Physical proof |
|---|---|---|
| RAW | Network/raw backend | NOT VERIFIED |
| ESC/POS | Test payload + network backend | NOT VERIFIED |
| ZPL | Test payload + network backend | NOT VERIFIED |
| TSPL | Test payload + network backend | NOT VERIFIED |
| Windows Spooler | Spooler backend | NOT VERIFIED |
| PDF/document | PDF payload/render path | NOT VERIFIED |
| IPP/IPPS | IPP backend | NOT VERIFIED |
| USB | Windows/raw or spooler paths | NOT VERIFIED |

A protocol enum or type is not treated as support proof; support classification here is based on actual backend code paths, while physical behavior remains unproven.

## Test-print path inspected

`Manager action → tenant-scoped printer lookup → tenant-scoped agent lookup → transport-aware test payload → durable job → fenced delivery → Agent execution path`.

The implementation avoids assuming every printer is a canned raw ticket endpoint and validates payload capabilities before inserting the job.

## Historical defects

- React error #441: structured failure path exists, but live browser regression is NOT VERIFIED.
- Manual printer admission mismatch: code now has explicit agent/printer ownership checks, but live heartbeat/UI path is NOT VERIFIED.
- Unknown physical outcome: Agent design intentionally avoids automatic blind reprint; operator-driven reprint exists in Gateway action layer.
- PDF/browser fallback: Gateway-enabled Odoo sale-detail path no longer silently falls back to native super behavior in the reviewed controller path.

## Final physical status

`BLOCKED-BY-ENVIRONMENT` — no Windows machine or representative physical printers were available.

An HTTP 200, spooler API success, or queued DB job must not be treated as physical print proof.
