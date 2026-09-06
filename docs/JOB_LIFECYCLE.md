# Job lifecycle

Everything below is implemented in:

* `src/lib/job-status.ts` — the state machine and physical-outcome classifier
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

## 2. Physical outcome is separate from logical status

The system exposes a derived `physicalOutcome` with exactly three meanings:

```text
not_printed  = there is evidence that no physical print was attempted/completed
printed      = the agent reported a successful print operation
unknown      = physical output may have occurred, but the gateway cannot prove it
```

`failed` does **not** automatically mean `not_printed`. In particular,
`AGENT_RESTART_DURING_PRINT`, `AGENT_EXECUTION_TIMEOUT`, and
`JOB_EXPIRED_DURING_PRINT` classify the physical outcome as `unknown`.

This is a semantic distinction, not a promise of exactly-once printing.

## 3. Creation

All print creation paths use `src/lib/print-job-service.ts` after their caller-specific
authentication/routing checks. The shared service is the authoritative boundary for:

* printer/agent/branch lifecycle validation;
* virtual/redirected printer rejection;
* payload capability validation;
* per-agent in-flight capacity;
* idempotency uniqueness;
* durable `queued` insertion;
* claim-and-deliver through the WebSocket fast path, with polling as fallback.

The delivery boundary revalidates branch, agent and printer lifecycle/runtime state after a job
has been queued. A printer or agent disabled/retired before claim is therefore not eligible for
new delivery even if the job already exists in PostgreSQL.

Odoo branch-routed requests additionally resolve a printer through routing first so fallback
selection and document-type authorization remain Odoo-specific policy. Manager and test-print
requests cannot bypass the shared safety invariants.

`expiresAt` defaults to now + 1 h and must be a future ISO-8601 instant when supplied.
Idempotent retries return the existing job with the same id; redelivery never creates a new id.

## 4. Routing

`resolvePrinterForJob({branchId, destinationId, documentType, payloadType})`:

1. branch must exist;
2. destination must exist in that branch;
3. enabled bindings are matched case-insensitively; empty document type is a wildcard;
4. candidates are ordered by priority and checked for branch ownership, lifecycle, runtime
   availability and payload capability;
5. the first valid candidate wins and fallback information is returned for audit;
6. failures remain typed (`CAPABILITY_MISMATCH`, `PRINTER_OFFLINE`, `PRINTER_DISABLED`, etc.)
   rather than being disguised as successful jobs.

## 5. Claim before delivery

The gateway must own a job before an agent may execute it.

For WebSocket delivery:

1. no open socket → `no_socket`; the job stays `queued`;
2. `claimJobForDelivery` changes `queued → claimed` only while branch, agent and printer are
   eligible; the PostgreSQL transaction locks those owner rows, giving the lifecycle decision a
   deterministic serialization point;
3. after that transaction commits, the envelope is written to exactly one open socket;
4. after a successful socket write, `delivered_at` is stamped;
5. if the write fails, the claim is immediately released back to `queued` under the same job id,
   or the job is failed after `MAX_DELIVERY_ATTEMPTS`.

For polling:

1. the poll transaction claims queued or stale delivery claims only for an enabled branch and
   active+online agent with an active+online printer;
2. the returned rows are `claimed`;
3. **polling does not set `delivered_at`** because returning an HTTP response is not proof that
   the agent received/processed the body;
4. the agent sends `job_ack` after receipt, which sets `acked_at` and, when needed,
   `delivered_at`.

Therefore `delivered_at` has one consistent meaning: the gateway has handed the job to its
agent transport. `acked_at` is the stronger application-level receipt confirmation.

## 6. Acknowledgement

The agent sends `{"type":"job_ack","jobId":"…"}` immediately after receiving a job and
before printing. The gateway records `acked_at` and leaves the job status unchanged.

An ACK is not proof that paper was printed. Late ACKs for terminal jobs are ignored.
Duplicate deliveries are also ACKed so the gateway can distinguish receipt from printing.

## 7. Printing and reporting

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

## 8. Failure, retry and recovery

| Situation | Behaviour |
|---|---|
| No WS socket | Job remains `queued`; poll can claim it later |
| WS write fails after claim | Immediate requeue under the same id; delivery attempt is counted |
| Five failed WS deliveries | Job becomes `failed` with an explicit delivery error (`not_printed`) |
| Stale `claimed` job | Reclaimed after `CLAIM_LEASE_SECONDS` (90 s), `retries + 1` |
| Stale `claimed` with retry budget exhausted | Permanently `failed` |
| Active `printing` job | **Not** reclaimed by the 90 s delivery lease |
| Stale `printing` job | Backstopped by the separate `STALE_PRINTING_SECONDS` execution lease (10 min; the agent refreshes it via heartbeat keep-alive while it legitimately works the job). While retry budget remains it is **requeued** to `queued` with `AGENT_RESTART_DURING_PRINT` so the crash-recovery policy (`reprint_after_crash`) can re-deliver it |
| Stale `printing` with retry budget exhausted | `failed` with `AGENT_EXECUTION_TIMEOUT`; physical outcome is **unknown** |
| Agent success after a sweep failure | Accepted once, only when the job is `failed` with an `AGENT_EXECUTION_TIMEOUT`/`AGENT_RESTART_DURING_PRINT` marker, no later result was recorded, and the failure is < 24 h old (`isLateSuccessAllowed`) — then physical outcome becomes `printed` |
| TTL passes while queued/claimed | Job becomes `expired` with physical outcome `not_printed` |
| TTL passes while printing | Job becomes `expired` with `JOB_EXPIRED_DURING_PRINT`; physical outcome is **unknown** |
| Printer error before successful handoff | Agent reports `failed`; physical outcome is `not_printed` unless the backend itself reports an ambiguous side effect |
| Capability mismatch | Agent reports `failed` with `CAPABILITY_MISMATCH`; physical outcome is `not_printed` |
| Duplicate already-successful local job | Not printed again; terminal result is re-reported |
| Agent crash during printing | Local result becomes `AGENT_RESTART_DURING_PRINT`; physical output is treated as unknown |
| Reprint policy disabled | Unknown physical jobs are held as failed/unknown and are not automatically printed again |
| Reprint policy enabled | Unknown physical jobs may be reprinted; this is explicitly at-least-once and duplicate paper is possible |

The important distinction is that the **90-second lease is a delivery lease, not a printing
lease**. A printer taking longer than 90 seconds cannot be classified as a lost delivery.

## 9. Field reference

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
| `physicalOutcome` | Derived semantic outcome: `not_printed`, `printed`, or `unknown`. |

There are three independent concepts:

* **Business TTL:** `expires_at`.
* **Delivery lease:** `claimed_at` / `updated_at` + 90 s while status is `claimed`.
* **Execution recovery lease:** `updated_at` + 10 min while status is `printing`.

The execution backstop is intentionally longer than the agent's normal physical print timeout.
It exists to recover jobs when an agent process dies and never reports a terminal result.

## 10. Agent crash behaviour

A job physically printing when the agent stops has an unknown physical outcome: full output,
partial output, or no output.

At startup `Queue.MarkInterrupted` marks local printing rows with
`AGENT_RESTART_DURING_PRINT`, and `recoverInterruptedJobs` reports the failure to the gateway.
The agent never claims that an unknown physical result was successfully printed.

`agent.reprint_after_crash` is **false by default**. When disabled, a subsequent delivery of an
interrupted local job is refused and the interruption is re-reported. When enabled, the agent
may print the job again. That mode is explicitly at-least-once and can produce duplicate physical
output. Exactly-once physical printing is not claimed by this system.

## 11. Capacity and idempotency

All job creation paths serialize capacity reservation with a transaction-scoped PostgreSQL
advisory lock per agent. The limit is `MAX_AGENT_IN_FLIGHT_JOBS = 500` and counts `claimed`
and `printing` rows with a live business TTL.

Idempotency is enforced by the database unique constraint on `(branch_id, idempotency_key)`
when a key is supplied. The shared service also handles the race where two callers check for
the same key concurrently: one insert wins and the other resolves the duplicate to the same
persisted job.

## 12. Ownership invariants

The canonical ownership chain is:

```text
Branch → Agent → Printer
```

Odoo owns business configuration such as branches, destinations, document types and bindings.
The Gateway/Agent owns runtime agents, physical printers and runtime status.

A binding cannot route across branches, and Odoo sync never invents a physical printer.

## 13. Lifecycle invariants

Agents and printers are lifecycle-managed rather than casually deleted. `retired` is terminal.
Disabling or retiring an agent disables its printers and revokes its credentials. Re-enabling a
disabled agent requires fresh pairing credentials.

A lifecycle change and a delivery claim are serialized through PostgreSQL row locks. If the
lifecycle update commits first, the queued job remains queued and cannot be claimed. If the claim
transaction wins the race, the delivery decision is linearized while the owner rows were still
eligible; the subsequent lifecycle change occurs after that decision rather than creating a
partially ordered race.

## 14. Production engineering rules

* Use the shared print-job service for every new print entry point.
* Never set `delivered_at` merely because a poll query selected a row.
* Never use the 90-second delivery lease to reclaim active printing work.
* Keep the same job id across retries and redelivery.
* Treat physical printing as at-least-once, not exactly-once.
* Surface `physicalOutcome` to operators and reconciliation code.
* PostgreSQL integration tests are required for claim, lifecycle, capacity and idempotency correctness.
