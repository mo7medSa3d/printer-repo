# Print Manager Architecture

## Authority boundary

- **Odoo** is the business/configuration source of truth: branches, destinations, document types, routing bindings and business report mapping.
- **Gateway** is the runtime authority/cache: paired agents, runtime printers, heartbeat, availability, jobs and execution/delivery state.
- Gateway-created branches are provisioning records that must be reconciled to Odoo; they are not a competing business authority.

## Ownership

```text
Odoo business configuration -> Gateway -> Branch -> Agent -> Printer -> physical device
```

The Gateway stores ownership only as `Agent.branchId` and `Printer.agentId`. A Printer's branch is derived by joining through its Agent. There is no writable `Printer.branchId` in the Gateway database.

Odoo mirrors the same relationship as `Branch -> Agent -> Printer`. Odoo `printer.branch_id` is a stored related value (`agent_id.branch_id`) only for search/indexing/display; it is derived and must never be edited independently.

## Lifecycle

Agents and Printers use `active <-> disabled` and `active/disabled -> retired`; `retired` is terminal. Disabling/retiring an Agent revokes credentials and disables its Printers. Re-enabling a disabled Agent requires fresh pairing credentials. A retired Agent is replaced by a new identity.

## Branch movement

Agents are not arbitrarily moved between branches after provisioning. The supported safe operation is retire the existing identity and create/re-pair a new Agent in the new Branch. This avoids transient cross-branch printer/binding inconsistency.

## Routing and content

Bindings are scoped to Branch and selected deterministically by priority then stable binding ID. A cross-branch mismatch fails closed. A Printer must have an active Agent and active lifecycle state to accept new jobs.

Payload content is explicit (`pdf`, `raw`, `escpos`). A PDF is never relabeled as RAW. PDF delivery requires a PDF-capable spooler or IPP path; actual byte-stream payloads must be supplied when RAW/ESC-POS is required.

## Idempotency and history

One logical print operation uses one stable idempotency key across retries. PostgreSQL uniqueness prevents concurrent duplicate logical jobs. Physical delivery remains potentially at-least-once. Jobs retain Agent/Printer/Branch foreign keys and lifecycle changes do not delete history.

## Synchronization

Odoo pull synchronization follows Branch -> Agents -> Printers -> Bindings. Non-2xx responses, timeouts and malformed JSON are failures. Complete synchronization is `success`; a failed optional runtime section is `partial`; required endpoint failure is `failed`.
## Production Engineering Semantics

- **Idempotency:** one persisted Odoo `print_gateway.print_job` is one logical print operation. Its `idempotency_key` is generated once, persisted before the Gateway HTTP call, and reused for transport/worker retries. A new manual print creates a new operation and therefore a new key. Physical delivery remains potentially at-least-once.
- **Agent availability:** routing requires `lifecycle=active`, `status=online`, and a fresh `lastSeenAt`. The default stale threshold is 90 seconds and is configurable with `STALE_AGENT_THRESHOLD_SECONDS` (10–3600 seconds). Administrative lifecycle and runtime availability are separate concepts.
- **Routing precedence:** exact `documentType` bindings always outrank generic bindings. Within each class, lower `priority` wins and `id ASC` breaks ties. Unavailable agents/printers are skipped for fallback; cross-branch inconsistencies fail closed.
- **Payloads:** canonical runtime payload types are `pdf`, `raw`, and `escpos`. PDF bytes must carry `%PDF-`; PDF is never relabeled as RAW/ESC/POS. **PCL is not supported end-to-end** and existing PCL configuration blocks migration until explicitly remediated.
- **Ownership:** `Branch → Agent → Printer`; Gateway printers have no independent branch ownership.
- **Lifecycle:** `active ↔ disabled`, `active/disabled → retired`; `retired` is terminal.
- **Database:** PostgreSQL integration tests are a required CI gate; unit tests and integration tests are separate commands.

