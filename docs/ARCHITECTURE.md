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
