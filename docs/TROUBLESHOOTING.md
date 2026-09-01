# Troubleshooting

Symptoms are grouped by where they appear. Every error string below is produced by code in
this repository.

## Job creation (Odoo → gateway)

| Response | Meaning | Fix |
|---|---|---|
| `401 Unauthorized (invalid branch-scoped Odoo API key)` | Unknown, revoked, or wrong-branch key | Re-issue the key in the dashboard (`POST /api/odoo/keys`), paste it into the branch |
| `403 API key is not allowed to create this document type` | The key has an `allowedDocumentTypes` list without this type, or `scope: read_only`. Matching is case/whitespace-insensitive, so a case difference is *not* the cause | Add the document type to the key or use a `standard` key |
| `400 INVALID_BRANCH` / `INVALID_DESTINATION` | The branch/destination does not exist, or the destination belongs to another branch | Run *Sync To Gateway*; check the ids Odoo sends |
| `404 NO_ROUTE` | No enabled binding matches (branch, destination, document type) | Create a binding; remember an empty binding document type is a wildcard |
| `404 NO_PRINTER_FOUND` | Bindings exist but every referenced printer row is missing/cross-branch | Re-run discovery, re-sync, check the printer's branch |
| `409 PRINTER_DISABLED` | Every candidate printer is administratively disabled | Enable the printer (dashboard or Odoo) |
| `503 PRINTER_OFFLINE` | Candidates are `offline`/`error` in the last heartbeat | Check the printer/agent; the job can simply be retried |
| `422 CAPABILITY_MISMATCH` | The payload type cannot be rendered by the routed printer (e.g. PDF to an ESC/POS-only device) | Route to a spooler/IPP printer, or change the report mapping's payload type |
| `400 payload.data must be valid base64…` | Payload violates the shared contract (type, encoding, size, canonical base64) | Check the addon's payload generation; the cap is 5 MiB decoded |
| `500 INTERNAL_ERROR: routing failed…` | Database/routing failure — deliberately not disguised as a 404 | Check gateway logs and PostgreSQL |

## Odoo sync

| Response | Meaning | Fix |
|---|---|---|
| `400 SYNC_DEPENDENCY_MISSING` + `printer does not exist…` | A binding references a printer that no agent has registered | Discover/register the printer first, then sync again. The gateway never creates printers from Odoo |
| `400 SYNC_VALIDATION_FAILED` + `does not belong to the synchronized branch` | Cross-branch destination/printer/binding, or a payload mixing branches | Fix the offending record named in `details` |
| `400 SYNC_VALIDATION_FAILED` + `a sync payload must target exactly one branch` | The payload mixed branches | Sync one branch at a time |
| `403` | The branch-scoped key does not match the payload's branch | Use the branch's own key |
| `500 SYNC_INTERNAL_ERROR` | Database failure — the whole sync was rolled back, nothing was written | Retry; check gateway logs |

Nothing is ever partially applied: a rejected sync writes no rows at all.

## Agent

| Symptom | Cause / fix |
|---|---|
| `401` on heartbeat or poll | Agent secret revoked or the agent row was deleted → re-pair (`-pair <code> -server <url>`) |
| Agent stays "offline" in the dashboard | Service not running (`sc query OdooPrintAgent`), wrong `server.url`, or outbound HTTPS blocked. Check `C:\ProgramData\OdooPrintAgent\logs\agent.log` |
| Agent starts but reports `no printers configured` | Run `odoo-agent-cli.exe printers discover`, or add a printer manually |
| Jobs stay `queued` | No agent socket **and** no poll: check the agent is running and that its `agent.id` matches the printer's agent |
| Jobs stay `claimed` and then retry | The delivery was lost; the 90 s claim lease reclaims them (`retries + 1`, same job id). Persistent looping ⇒ check the WebSocket connection and the agent log |
| Job fails with `CAPABILITY_MISMATCH: printer … cannot print pdf payloads` | The agent-side capability gate: the printer backend cannot render PDF (raw TCP / raw USB). Use a spooler queue or IPP |
| Job fails with `PDF print on "…" failed: … printto …` | No PDF handler registered for the `printto` verb, or it exited non-zero. Install a PDF reader or set `agent.pdf_print_command` |
| Job fails with `payload is not a PDF document (missing %PDF- header)` | The report did not render a PDF (empty/HTML output) |
| Job fails with `refusing to print PDF: printer name contains a quote character` | The Windows printer name contains `"` or a control character — rename the queue |
| `AGENT_RESTART_DURING_PRINT` in a job error | The agent stopped while that job was printing; the physical outcome is unknown. See [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md) §9 and the `agent.reprint_after_crash` setting |
| Duplicate pages after a crash | Expected with `reprint_after_crash: true` (at-least-once). Set it to `false` on duplicate-sensitive sites |
| `exceeded max retries after a stale claim` | Five reclaims without a result — the agent kept dying or losing the job. Inspect the agent log |

## Printing quality

| Symptom | Cause |
|---|---|
| Pages of PDF source text / garbage on a thermal printer | A PDF reached a byte-stream printer. This is exactly what `CAPABILITY_MISMATCH` prevents — check that the printer's `capabilities.supported_protocols` is accurate and that no binding routes PDFs there |
| Receipt prints but does not cut | ESC/POS payload without `GS V`; check the payload generator |
| Nothing prints but the job says `success` | "Success" means the transport accepted the document (socket/spooler/handler), not that paper came out. Check the Windows print queue and the device |

## Desktop manager

| Symptom | Cause / fix |
|---|---|
| White window | WebView2 missing (the installer's bootstrapper should fetch it) or a bad gateway URL |
| "Gateway check failed" | `/api/health` unreachable from the PC — check URL, TLS, firewall |
| Jobs tab shows 401 | `/api/jobs` needs a manager session; sign in at the gateway dashboard in the same browser context, or use the dashboard directly |
| Start/Stop Agent does nothing | The service exists but the user is not elevated; run the app as administrator or control the service with `sc` |

## Gateway server

| Symptom | Cause / fix |
|---|---|
| `DATABASE_URL is required at runtime` | The build succeeded without a database; set `DATABASE_URL` before `npm start` |
| Login returns 500 "Manager auth not configured" | Set `MANAGER_USERNAME` and `MANAGER_PASSWORD`/`MANAGER_PASSWORD_HASH` |
| Signing fails / sessions rejected | `GATEWAY_JWT_SECRET` missing or shorter than 32 characters |
| `/api/health` returns `{"ok":false}` with 500 | PostgreSQL unreachable |
| WebSocket clients get 401 | The agent's `Authorization: Bearer <id>:<secret>` is wrong; re-pair |
| Jobs never leave `queued` for a WS-connected agent | Confirm the reverse proxy forwards WebSocket upgrades to `/api/agent/ws` |

## Diagnostics checklist

1. `GET /api/health` — database reachable, agent/printer/job counts.
2. Dashboard → agent `lastSeenAt` (heartbeat is every 30 s).
3. `GET /api/jobs?limit=50` (manager) or `GET /api/print/jobs?id=…` (Odoo key) — real status,
   `retries`, `delivery_attempts`, `error`.
4. `C:\ProgramData\OdooPrintAgent\logs\agent.log` — per-job lines including the chosen print
   path (`type=pdf path=pdf`) and the backend error text.
5. Odoo → **Print Gateway → Print Jobs** — the mirrored status and the gateway job id.
