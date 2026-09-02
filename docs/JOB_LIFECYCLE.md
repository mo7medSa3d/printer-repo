# Job lifecycle

Everything below is implemented in:

* `src/lib/job-status.ts` — the state machine
* `src/lib/job-delivery.ts` — claim / delivery / ack / release
* `src/app/api/print/jobs/route.ts` — job creation (Odoo)
* `src/app/actions.ts` — job creation (manager test print)
* `src/app/api/agent/jobs/route.ts` — poll claim, TTL sweep, stale reclaim, status PATCH
* `src/server/ws.ts` — WebSocket delivery
* `agent/internal/agent/agent.go`, `agent/internal/queue/queue.go` — agent side

## 1. States

```
queued ──claim (gateway, transactional)──► claimed ──delivery──► printing ──► success
                                              │                      │
                                              └──────────────────────┴──► failed
any non-terminal state ──TTL passed──► expired
```

`JOB_STATUSES = queued | claimed | printing | success | failed | expired`
(`src/lib/job-status.ts`). `success`, `failed` and `expired` are terminal.

Transitions an **agent** may request via `PATCH /api/agent/jobs`:

| from | allowed to |
|---|---|
| `queued` | *(nothing — an agent can never move a job out of queued)* |
| `claimed` | `printing`, `failed`, `expired` |
| `printing` | `success`, `failed`, `expired` |
| terminal | *(nothing)* |

`queued → claimed` happens **only** server-side, inside the claim transaction.

## 2. Creation

1. `POST /api/print/jobs` authenticates the Odoo key (branch-scoped) and checks the
   key's `allowedDocumentTypes` (compared case-insensitively, like routing).
2. The payload is validated against the shared contract (`type` ∈ `raw|escpos|pdf`,
   `encoding: "base64"`, decoded size 1 B … 5 MiB, canonical base64).
3. `expiresAt` defaults to now + 1 h; an explicit value must be a future ISO-8601 instant.
4. **Idempotency**: if `idempotencyKey` is supplied and a job already exists for
   `(branch_id, idempotency_key)`, the existing job is returned with HTTP 200. Otherwise a
   new id `job_<nanoid(12)>` is generated. Concurrent duplicates collide on the partial
   unique index `print_jobs_branch_idempotency_unique` and are resolved to the same existing
   job. **A retry or redelivery never creates a second job id.**
5. Routing resolves the printer (§3). Failures return an error code instead of a job.
6. The row is inserted with `status='queued'`, then the gateway attempts claim-and-deliver
   (§4). The HTTP response reports the **real** row status: `claimed` when the job was
   delivered to a connected agent, `queued` when it is waiting for the poll path.

## 3. Routing

`resolvePrinterForJob({branchId, destinationId, documentType, payloadType})`:

1. branch must exist → else `INVALID_BRANCH` (400)
2. destination must exist **in that branch** → else `INVALID_DESTINATION` (400)
3. enabled bindings for (branch, destination) are loaded; the document type is matched
   case-insensitively, an empty binding type is a wildcard → no match ⇒ `NO_ROUTE` (404)
4. candidates are ordered by ascending `priority` and each is checked in turn; a candidate
   is skipped when the printer row is missing, belongs to another branch, is disabled,
   is `offline`/`error`, fails the capability check, or its agent belongs to another branch
5. the first surviving candidate wins; `fallbackUsed` and the full `fallbackChain` are
   returned for auditing
6. if nothing survives, the most specific reason is returned:
   `CAPABILITY_MISMATCH` (422) → `PRINTER_OFFLINE` (503) → `PRINTER_DISABLED` (409) →
   `NO_PRINTER_FOUND` (404). A database failure is `INTERNAL_ERROR` (500), never a fake 404.

`PRINTER_OFFLINE` is preferred over `PRINTER_DISABLED` when both occurred, because an
offline printer may recover on its own (retry) while a disabled one needs a configuration
change.

## 4. Claim before delivery

The gateway never hands a job to an agent before it owns it
(`claimAndPushJobToAgent` in `src/server/ws.ts`, `claimJobForDelivery` in
`src/lib/job-delivery.ts`):

1. no open socket for that agent → return `no_socket`; the row stays `queued` for the poll
   path (nothing is claimed, `delivery_attempts` stays 0)
2. otherwise, in ONE transaction:
   ```sql
   SELECT id FROM print_jobs
    WHERE id = $1 AND agent_id = $2 AND status = 'queued' AND expires_at > now()
      FOR UPDATE SKIP LOCKED;
   UPDATE print_jobs
      SET status='claimed', claimed_at=now(), updated_at=now(),
          delivery_attempts = delivery_attempts + 1
    WHERE id = $1 AND agent_id = $2 AND status='queued' AND expires_at > now()
   RETURNING …;
   ```
   A concurrent claimer (second WS push, poll, another gateway instance) gets nothing →
   `not_claimable`.
3. after COMMIT the envelope is written to exactly one open socket (the newest); writing to
   every socket of the agent would be a duplicate delivery
4. on a successful write, `delivered_at` is stamped
5. if the write fails, `releaseUndeliveredClaim` puts the row back to `queued`
   (`claimed_at = NULL`, same job id) — or fails it explicitly once
   `MAX_DELIVERY_ATTEMPTS` (5) is reached.

For the poll path the claim and the delivery record commit together, because the HTTP
response is the delivery (`delivered_at = now()`, `acked_at = NULL`,
`delivery_attempts + 1` in the same UPDATE).

## 5. Acknowledgement

The agent replies `{"type":"job_ack","jobId":"…"}` immediately on receipt — including for a
duplicate it will not print. The gateway sets `acked_at` (and `delivered_at` if missing) and
**does not change the job status**: an ack means "received", never "printed".
Unknown message types are ignored. See [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md).

## 6. Printing and reporting

The agent, per job: TTL re-check → local terminal check → printer lookup → payload parse →
capability gate → per-printer mutex → local `queue.Push` + `printing` → `PATCH printing` →
physical print (20 s context timeout) → local `success`/`failed` → `PATCH success|failed`
with the real error text.

Status PATCH rules (`src/app/api/agent/jobs/route.ts`): the job must belong to the calling
agent (and its branch), TTL always wins (past `expires_at` ⇒ the row is set to `expired` and
the call returns 409), and the transition must be allowed by `canTransition` (else 409).

## 7. Failure, retry and recovery

| Situation | What happens |
|---|---|
| WebSocket write fails after the claim | Claim released, row back to `queued` with the same id; after 5 delivery attempts the job is failed with an explicit error |
| Agent disconnects before reporting | The claim goes stale after `CLAIM_LEASE_SECONDS` (90 s). The next poll reclaims it: `status='claimed'`, `claimed_at=now()`, `retries + 1`, **same job id** |
| Stale claim with `retries >= 5` | Job is set to `failed` with "exceeded max retries after a stale claim" |
| TTL passes | The TTL sweep in the poll endpoint (and the PATCH handler) sets the job to `expired` |
| Printer error | Agent reports `failed` with the backend's real error text (never a swallowed error) |
| Capability mismatch detected on the agent | `failed` with `CAPABILITY_MISMATCH: …` |
| Duplicate delivery of a job that already succeeded locally | Not printed again; the stored terminal result is re-reported |
| Duplicate delivery of a job that failed locally | Retried — the gateway only redelivers after an explicit reclaim that already incremented `retries` |
| Agent crashed **while printing** | See §9 |

## 8. Field reference

| Column | Set by | Meaning |
|---|---|---|
| `expires_at` | Job creation (Odoo `expiresAt` or now + 1 h) | Business TTL of the job. Never shortened by a claim. Past it, the job is `expired` regardless of what the agent reports |
| `claimed_at` | Claim (WS or poll) | When the gateway took ownership. The claim **lease** is `claimed_at + 90 s` (`CLAIM_LEASE_SECONDS` in `src/lib/job-delivery.ts` == `STALE_CLAIM_SECONDS` in the poll route) |
| `delivery_attempts` | Every claim | How many times the gateway tried to hand the job over. Bounded by `MAX_DELIVERY_ATTEMPTS = 5` for undelivered WS claims |
| `delivered_at` | WS: after a successful socket write. Poll: in the claim statement | The job actually left the gateway |
| `acked_at` | `job_ack` from the agent | The agent confirmed receipt. Never implies printing |
| `retries` | Stale-claim reclaim in the poll endpoint | How many times the job was re-delivered after a lost/stale claim. `>= 5` ⇒ permanent failure |
| `updated_at` | Every mutation | Also used as the staleness clock for `claimed`/`printing` rows |
| `error` | Agent PATCH, delivery release, retry exhaustion | Human-readable reason, truncated to 2000 chars |

Two distinct clocks: **TTL** (`expires_at`, business deadline) and **claim lease**
(`claimed_at`/`updated_at` + 90 s, delivery deadline). They are deliberately independent —
overwriting `expires_at` with the lease would silently change job expiry semantics.

## 9. Agent crash behaviour (at-least-once, made visible)

A job that was still physically printing when the agent process stopped has an **unknown**
outcome: the printer may have produced the full document, part of it, or nothing.

At startup the agent scans its local queue (`Queue.MarkInterrupted`), moves every row still
in `printing` to a terminal local `failed` state carrying the marker
`AGENT_RESTART_DURING_PRINT`, logs a warning, and reports the failure to the gateway
immediately (`recoverInterruptedJobs`). Previously such a row stayed `printing` locally and
the gateway only noticed after the 90 s lease, then re-delivered the job and a duplicate
page came out with nobody informed.

What happens if that job is delivered again is a policy setting
(`agent.reprint_after_crash` in the agent config):

| value | behaviour |
|---|---|
| `true` (default) | Print it again. No document is lost, but a duplicate page can be produced. This is the historical at-least-once behaviour |
| `false` | Refuse and re-report the interruption. No duplicate is ever produced automatically; recovering the document requires a new job |

**Neither setting provides exactly-once physical printing**, and this repository does not
claim it anywhere. Covered by `TestInterruptedJobIsReportedAtStartup` and
`TestReprintAfterCrashPolicy` (`agent/internal/agent/ws_delivery_test.go`) and
`TestMarkInterruptedFlagsMidPrintJobs` (`agent/internal/queue/queue_test.go`).

## 10. Odoo-side mirror

`print_gateway.print_job` stores `gateway_job_id`, branch, destination, document type,
printer, agent, status, error and the originating report metadata. The cron
`Print Gateway: Sync Job Statuses` (every 2 minutes) calls
`GET /api/print/jobs?id=…` for every non-terminal job and normalises `completed → success`.

## Agent and printer lifecycle invariants

Agents and Printers are never physically deleted by normal application flows. Use `disabled` to stop runtime use without retiring identity; use `retired` for terminal decommissioning. `retired` cannot transition back to `active` or `disabled`. Historical Jobs remain queryable.

Disabling or retiring an Agent revokes its credentials and disables all of its Printers. A disabled Agent can later be enabled only with fresh pairing credentials. A retired Agent must be replaced by a new identity.

## Agent and printer lifecycle invariants

Agents and Printers are never physically deleted by normal application flows. `retired` is terminal, and historical Jobs remain queryable. Disabling or retiring an Agent revokes its credentials and disables all of its Printers. Re-enabling a disabled Agent requires fresh pairing credentials.
## Production Engineering Semantics

- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.

