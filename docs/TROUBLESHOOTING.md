# Troubleshooting

## Odoo Gateway configuration

| Symptom | Meaning | Fix |
|---|---|---|
| `401 Unauthorized` | API key missing, invalid, or revoked | Re-copy a newly generated key into Odoo |
| Gateway URL rejected | Unsupported scheme, credentials, query/fragment, API path, or private target | Use the Gateway origin only and allow-list private targets explicitly when required |
| `Gateway is unavailable` | DNS, TLS, firewall, or Gateway process failure | Check the Gateway health endpoint and outbound connectivity from Odoo |
| `Gateway health check failed` | Authentication or health response failure | Validate the API key and Gateway runtime |

## Print job creation

| Response | Meaning | Fix |
|---|---|---|
| `404 printer not found` | The binding points to a runtime printer identity that Gateway does not know | Check the Gateway runtime inventory and correct the Odoo binding |
| `409` | Runtime printer/job conflict | Inspect the Gateway job/printer state and retry only when safe |
| `422 CAPABILITY_MISMATCH` | Printer cannot execute the payload type | Bind the document to a compatible runtime printer |
| `429` | Gateway rate limit | Respect `Retry-After` and allow the outbox retry path to proceed |
| `503` | Agent/printer runtime unavailable | Check Agent heartbeat and printer availability |

## Missing binding

When Gateway Printing is enabled, absence of a binding is an error. The Odoo router must not call native/browser printing after this error.

Create or correct:

`Destination + Document Type -> Printer`

## POS

POS receipt printing, reprint, and Restaurant Print Bill are intercepted at `PosStore.printReceipt()`.

If a Gateway-enabled POS action opens a browser print dialog, treat it as a release regression: inspect the POS asset load and verify that the Gateway-enabled branch of the interceptor does not call the native `super.printReceipt()` path.

## Browser fallback

Gateway-enabled printing must never invoke:

- browser print preview/dialog
- `window.print()`
- report URL navigation
- PDF opening/download as the print path
- native POS printer fallback

Native Odoo printing is expected only when Gateway printing is explicitly disabled.

## Reliability

A persisted Odoo print job keeps one idempotency key across submission retries. Do not create a new Odoo job merely because the Gateway request timed out; reconcile the existing job first because the physical outcome may be unknown.

## Agent / printer runtime

The Gateway dashboard is the authoritative runtime inventory. Odoo does not create or synchronize Agent or Printer records.

Check Agent heartbeat, runtime printer status, supported payload capabilities, and Gateway job state when a job remains queued or fails.

## Logs

Do not paste API keys, Agent secrets, manager sessions, or raw payload bytes into support tickets. Application logs should contain only diagnostic metadata and safe error categories.
