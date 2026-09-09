# Job lifecycle

The Gateway logical state and the physical outcome are separate. Logical state records what the
software knows; physical outcome records what can actually be inferred after a side-effecting
printer operation.

## Logical states

```text
queued → claimed → printing → success
                         └──→ failed
non-terminal + TTL expiry → expired
```

`success`, `failed`, and `expired` are terminal logical states.

## Physical outcome

```text
not_printed
printed
unknown
```

`success` means the agent/backend reported successful operation. For RAW TCP and spooler backends
this is evidence that the operation handed work to the transport; it is not a physical sensor
proving paper emerged.

A job is `unknown` when the process lost the ability to prove whether the physical side effect
happened, including an agent crash during printing, execution timeout, or TTL expiry while
printing.

## Delivery lifecycle

1. Print creation persists one durable `queued` row with a stable idempotency key when supplied.
2. The Gateway claims a queued row transactionally only while the owning agent and printer remain
   eligible.
3. The WebSocket fast path sends the claimed job to one open socket. A failed socket write is
   released back to `queued` while no physical operation has started.
4. Polling is a recovery path. Selecting a row for an HTTP response is not proof that the agent
   received it; the agent sends `job_ack` after receipt.
5. The agent enters `printing` before calling the printer backend and reports the final result.

## Lifecycle fencing

Both WebSocket and polling claims revalidate inside PostgreSQL transactions:

```text
agent.lifecycle = active
agent.status = online
printer.lifecycle = active
printer.status = online
job.status = queued
job.expires_at > now()
```

The owner rows are locked at the claim decision point. A lifecycle change is therefore serialized
with the claim instead of being protected by an in-memory pre-check.

## Cross-path delivery invariants

These hold identically across WebSocket delivery, polling delivery, ACK,
heartbeats, sweeps and agent reports - verified by
`tests/ws-claim-delivery.test.ts`, `tests/e2e-job-flow.test.ts`,
`tests/heartbeat-enabled.test.ts` and `tests/job-status-postgres-concurrency.test.ts`:

* **Claim ownership is token-fenced.** Every claim mints a fresh
  `claim_token`; every lifecycle UPDATE, delivery-evidence write, release
  and lease refresh predicates on it inside PostgreSQL. No in-memory
  comparison is a security boundary.
* **Delivery evidence is attempt-specific.** `delivered_at`/`acked_at` are
  stamped only when the agent demonstrably holds that attempt (fenced WS
  mark, fenced ack, fenced status report) - never by the server committing
  a claim or a response. Heartbeat keep-alives extend the lease only.
* **Pre-execution rejection is safely requeueable.** A fenced
  `claimed -> queued` return (pending_full / agent_shutting_down /
  ledger_unavailable) clears token, timestamps and claim time, so the row
  unambiguously means "nothing was physically dispatched".
* **Delivered-but-silent is never silently auto-reprinted.** It becomes
  terminal `failed` with an `UNKNOWN_PARTIAL_DELIVERY` marker; only a
  deliberate operator reprint may re-issue it.
* **Stale workers cannot physically dispatch after losing ownership.** The
  gateway rejects their reports at the fence, and the agent hard-stops
  before `PrintDocument` when its claim is rejected or when ownership
  freshness is unprovable (transport failure past the lease window).

## Failure semantics

| Situation | Gateway behaviour | Physical outcome |
|---|---|---|
| No agent socket | job remains queued | not_printed |
| WS write fails before delivery | same job requeued | not_printed |
| Stale `claimed` lease WITHOUT delivery evidence | requeue under a fresh claim token until retry budget | not_printed |
| Stale `claimed` lease WITH delivery evidence | terminal `failed` with `UNKNOWN_PARTIAL_DELIVERY` | unknown |
| Stale undelivered `claimed` after retry budget | terminal `failed` | not_printed |
| Agent crashes during printing | interruption marker recorded | unknown |
| Stale `printing` execution lease | terminal `failed` with `AGENT_EXECUTION_TIMEOUT` | unknown |
| TTL expires while `printing` | terminal `expired` with `JOB_EXPIRED_DURING_PRINT` | unknown |
| TTL expires after delivery without execution report | terminal `expired` with `UNKNOWN_PARTIAL_DELIVERY` | unknown |
| Capability/transport rejection before handoff | terminal `failed` | not_printed |
| Successful agent result | terminal `success` | printed* |

`*` `printed` means software-confirmed successful transport/backend completion, not a guarantee
that the physical device produced the intended paper.

## Unknown outcome policy

The Gateway **does not automatically requeue a stale physical print**. A physical side effect may
already have happened, and automatic retry could create duplicate business documents.

The original job ID and diagnostic marker are preserved. An operator or a higher-level business
workflow must reconcile an unknown document before creating a new print operation when duplicate
paper would be harmful.

A late agent `success` is accepted only for a recent terminal failure carrying an explicit unknown
marker and only once. This closes the existing logical job rather than creating a second job.

## Crash-reprint option

The Go agent setting `agent.reprint_after_crash` is **false by default**. It is an explicit local
business policy for deliberately retrying an interrupted operation. Enabling it means the resulting
physical semantics are at-least-once and duplicate paper is possible. The normal Gateway
maintenance loop does not silently enable this policy.

## Idempotency and multi-instance operation

Duplicate logical requests from the same Odoo installation with the same idempotency key resolve
to the same durable job (the unique index is scoped by `api_key_id`), with the database uniqueness
constraint as the concurrency backstop.

Each Gateway process keeps WebSocket sockets in memory, but PostgreSQL is the durable source of
truth. `LISTEN/NOTIFY` is a wake-up hint only; polling and transactional claims are the recovery
path when a notification is lost or a Gateway replica restarts.
