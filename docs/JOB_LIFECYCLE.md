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
2. The Gateway claims a queued row transactionally only while branch, agent, and printer remain
   eligible.
3. The WebSocket fast path sends the claimed job to one open socket. A failed socket write is
   released back to `queued` while no physical operation has started.
4. Polling is a recovery path. Selecting a row for an HTTP response is not proof that the agent
   received it; the agent sends `job_ack` after receipt.
5. The agent enters `printing` before calling the printer backend and reports the final result.

## Lifecycle fencing

Both WebSocket and polling claims revalidate inside PostgreSQL transactions:

```text
branch.enabled = true
agent.lifecycle = active
agent.status = online
printer.lifecycle = active
printer.status = online
job.status = queued
job.expires_at > now()
```

The owner rows are locked at the claim decision point. A lifecycle change is therefore serialized
with the claim instead of being protected by an in-memory pre-check.

## Failure semantics

| Situation | Gateway behaviour | Physical outcome |
|---|---|---|
| No agent socket | job remains queued | not_printed |
| WS write fails before delivery | same job requeued | not_printed |
| Stale `claimed` lease | requeue until retry budget | not_printed |
| Stale `claimed` after retry budget | terminal `failed` | not_printed |
| Agent crashes during printing | interruption marker recorded | unknown |
| Stale `printing` execution lease | terminal `failed` with `AGENT_EXECUTION_TIMEOUT` | unknown |
| TTL expires while `printing` | terminal `expired` with `JOB_EXPIRED_DURING_PRINT` | unknown |
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

Duplicate logical requests with the same branch-scoped idempotency key resolve to the same durable
job, with the database uniqueness constraint as the concurrency backstop.

Each Gateway process keeps WebSocket sockets in memory, but PostgreSQL is the durable source of
truth. `LISTEN/NOTIFY` is a wake-up hint only; polling and transactional claims are the recovery
path when a notification is lost or a Gateway replica restarts.
