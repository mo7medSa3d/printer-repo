# Job lifecycle

Everything below is implemented in:

* `src/lib/job-status.ts` — the state machine
* `src/lib/job-delivery.ts` — claim / delivery / ack / release
* `src/lib/print-job-service.ts` — the single job-creation invariant boundary
* `src/app/api/print/jobs/route.ts` — Odoo API
* `src/app/actions.ts` — Manager actions
* `src/app/api/printers/[id]/test-print/route.ts` — Manager/Odoo test print
* `src/app/api/agent/jobs/route.ts` — poll claim, TTL sweep, stale recovery, status PATCH
* `src/server/ws.ts` — WebSocket delivery
* `agent/internal/agent/agent.go`, `agent/internal/queue/queue.go` — agent side

## 1. States

```text
queued ──claim (gateway, transactional)──► claimed ──printing──► success
                                              │              └──► failed
                                              └──────────────────► failed
any non-terminal state ──TTL passed──► expired
```

`success`, `failed` and `expired` are terminal.

An agent may request only `claimed → printing|failed` and `printing → success|failed`.
`queued → claimed` is gateway-controlled and can never be requested by the agent.

## 2. Creation

All print creation paths use `src/lib/print-job-service.ts` after their caller-specific
authentication/routing checks. The shared service is the authoritative boundary for:

* printer/agent/branch lifecycle validation;
* virtual/redirected printer rejection;
* payload capability validation;
* per-agent in-flight capacity;
* idempotency uniqueness;
* durable `queued` insertion;
* claim-and-deliver through the WebSocket fast path, with polling as fallback.

Odoo branch-routed requests additionally resolve a printer through routing first so fallback
selection and document-type authorization remain Odoo-specific policy. Manager and test-print
requests cannot bypass the shared safety invariants.

`expiresAt` defaults to now + 1 h and must be a future ISO-8601 instant when supplied.
Idempotent retries return the existing job with the same id; redelivery never creates a new id.

## 3. Routing

`resolvePrinterForJob({branchId, destinationId, documentType, payloadType})`:

1. branch must exist;
2. destination must exist in that branch;
3. enabled bindings are matched case-insensitively; empty document type is a wildcard;
4. candidates are ordered by priority and checked for branch ownership, lifecycle, runtime
   availability and payload capability;
5. the first valid candidate wins and fallback information is returned for audit;
6. failures remain typed (`CAPABILITY_MISMATCH`, `PRINTER_OFFLINE`, `PRINTER_DISABLED`, etc.)
   rather than being disguised as successful jobs.

## 4. Claim before delivery

The gateway must own a job before an agent may execute it.

For WebSocket delivery:

1. no open socket → `no_socket`; the job stays `queued`;
2. otherwise `claimJobForDelivery` atomically changes `queued → claimed` in a transaction;
3. after the transaction commits, the envelope is written to exactly one open socket;
4. after a successful socket write, `delivered_at` is stamped;
5. if the write fails, the claim is immediately released back to `queued` under the same job id,
   or the job is failed after `MAX_DELIVERY_ATTEMPTS`.

For polling:

1. the poll transaction claims queued or stale delivery claims;
2. the returned rows are `claimed`;
3. **polling does not set `delivered_at`** because returning an HTTP response is not proof that
   the agent received/processed the body;
4. the agent sends `job_ack` after receipt, which sets `acked_at` and, when needed,
   `delivered_at`.

Therefore `delivered_at` has one consistent meaning: the gateway has handed the job to the
agent transport. `acked_at` is the stronger application-level receipt confirmation.

## 5. Acknowledgement

The agent sends `{"type":"job_ack","jobId":"…"}` immediately after receiving a job and
before printing. The gateway records `acked_at` and leaves the job status unchanged.

An ACK is not proof that paper was printed. Late ACKs for terminal jobs are ignored.
Duplicate deliveries are also ACKed so the gateway can distinguish receipt from printing.

## 6. Printing and reporting

The agent performs:

1. TTL re-check;
2. local terminal/idempotency check;
3. printer lookup;
4. payload parse and capability gate;
5. per-printer serialization;
6. durable local queue insertion and local `printing` state;
7. `PATCH printing` to the gateway;
8. physical print with a bounded execution context;
9. local `success`/`failed` persistence;
10. `PATCH success|failed` with the actual result.

A successful RAW/TCP write means bytes were handed to the configured transport. It does not
prove that paper physically emerged from the printer.

## 7. Failure, retry and recovery

| Situation | Behaviour |
|---|---|
| No WS socket | Job remains `queued`; poll can claim it later |
| WS write fails after claim | Immediate requeue under the same id; delivery attempt is counted |
| Five failed WS deliveries | Job becomes `failed` with an explicit delivery error |
| Stale `claimed` job | Reclaimed after `CLAIM_LEASE_SECONDS` (90 s), `retries + 1` |
| Stale `claimed` with retry budget exhausted | Permanently `failed` |
| Active `printing` job | **Not** reclaimed by the 90 s delivery lease |
| Stale `printing` job | Recovered only after the separate `STALE_PRINTING_SECONDS` execution backstop (10 min) |
| TTL passes | Job becomes `expired`; TTL is independent of claim/execution leases |
| Printer error | Agent reports `failed` with the backend error |
| Capability mismatch | Agent reports `failed` with `CAPABILITY_MISMATCH` |
| Duplicate already-successful local job | Not printed again; terminal result is re-reported |
| Agent crash during printing | Local result becomes `AGENT_RESTART_DURING_PRINT`; physical output is treated as unknown |

The important distinction is that the **90-second lease is a delivery lease, not a printing
lease**. A printer taking longer than 90 seconds cannot be classified as a lost delivery.

## 8. Field reference

| Column | Meaning |
|---|---|
| `expires_at` | Business TTL. Never shortened by claiming. |
| `claimed_at` | Last gateway ownership claim time. |
| `delivery_attempts` | Number of gateway claim/delivery attempts. |
| `delivered_at` | Gateway successfully handed the job to its transport. |
| `acked_at` | Agent explicitly confirmed receipt. |
| `retries` | Number of stale-claim recovery cycles. |
| `updated_at` | Last mutation time; used by delivery/execution recovery clocks. |
| `error` | Latest human-readable failure/recovery reason, max 2000 chars. |

There are three independent concepts:

* **Business TTL:** `expires_at`.
* **Delivery lease:** `claimed_at` / `updated_at` + 90 s while status is `claimed`.
* **Execution recovery lease:** `updated_at` + 10 min while status is `printing`.

The execution backstop is intentionally longer than the agent's normal physical print timeout.
It exists to recover jobs when an agent process dies and never reports a terminal result.

## 9. Agent crash behaviour

A job physically printing when the agent stops has an unknown physical outcome: full output,
partial output, or no output.

At startup `Queue.MarkInterrupted` marks local printing rows with
`AGENT_RESTART_DURING_PRINT`, and `recoverInterruptedJobs` reports the failure to the gateway.
The agent never claims that an unknown physical result was successfully printed.

`agent.reprint_after_crash` controls whether a subsequent delivery may be printed again. Even
when enabled, this is at-least-once delivery and can produce duplicate physical output.
Exactly-once physical printing is not claimed by this system.

## 10. Capacity and idempotency

All job creation paths serialize capacity reservation with a transaction-scoped PostgreSQL
advisory lock per agent. The limit is `MAX_AGENT_IN_FLIGHT_JOBS = 500` and counts `claimed`
and `printing` rows with a live business TTL.

Idempotency is enforced by the database unique constraint on `(branch_id, idempotency_key)`
when a key is supplied. The shared service also handles the race where two callers check for
the same key concurrently: one insert wins and the other resolves the duplicate to the same
persisted job.

## 11. Ownership invariants

The canonical ownership chain is:

```text
Branch → Agent → Printer
```

Odoo owns business configuration such as branches, destinations, document types and bindings.
The Gateway/Agent owns runtime agents, physical printers and runtime status.

A binding cannot route across branches, and Odoo sync never invents a physical printer.

## 12. Lifecycle invariants

Agents and printers are lifecycle-managed rather than casually deleted. `retired` is terminal.
Disabling or retiring an agent disables its printers and revokes its credentials. Re-enabling a
disabled agent requires fresh pairing credentials.

## 13. Production engineering rules

* Use the shared print-job service for every new print entry point.
* Never set `delivered_at` merely because a poll query selected a row.
* Never use the 90-second delivery lease to reclaim active printing work.
* Keep the same job id across retries and redelivery.
* Treat physical printing as at-least-once, not exactly-once.
* PostgreSQL integration tests are required for claim, capacity and idempotency correctness.
