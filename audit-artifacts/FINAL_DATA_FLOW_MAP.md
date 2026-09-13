# FINAL_DATA_FLOW_MAP.md (authoritative transitions)

## Print job lifecycle (single coherent definition, enforced in 3 languages)
`queued → claimed → printing → success | failed | expired` (gateway DB CHECK).
Odoo outbox mirrors with `submitted` (accepted by gateway) and terminal `unknown`/`partial` operator states (Odoo-only; never written by gateway sync).

## Per-transition authority
| Transition | Owner | Fence | Evidence |
|---|---|---|---|
| create | Odoo router / manager / test-print | per-key rate limit + queue caps + capability matrix + idempotency fingerprint (advisory locks) | PG row `queued` |
| WS claim | gateway push | advisory lock + in-flight cap + runtime availability + fresh `claim_token` | row `claimed` |
| poll claim | gateway poll | same + stale-undelivered-only reclaim | row `claimed`, new token |
| deliver | gateway→agent | `markJobDelivered` fenced on token; failure → release (requeue/refund rules) | `delivered_at` |
| ack | agent `job_ack` | fenced on token | `acked_at` (+delivered_at coalesce) |
| keepalive | agent heartbeat | token-tuple match only | `updated_at` lease extension |
| printing | agent report | fenced on (id, agent, status, token); reports also stamp delivery evidence | `delivered_at` coalesce |
| pre-exec reject | agent (`pending_full`, `agent_shutting_down`, `ledger_unavailable`) | fenced; refunds delivery charge, consumes retry | `queued`, token cleared |
| success/failed | agent terminal report | fenced; late-success windows for timeout/expiry markers | terminal |
| expired | sweep (30 s) OR agent self-report (fenced + DB clock) | `expires_at <= now()` | `expired` + honest error |
| sweep requeue | sweep | undelivered + stale + budgets | `queued`, retries+1 |
| sweep unknown | sweep | delivered-but-silent / stale printing / exhausted | terminal failed + marker |
| Odoo sync | cron (batch then per-job) | maps gateway status incl. unknown markers; missing rows → local `unknown` | outbox state |
| Odoo retry | operator only, new uuid key (failed+not_printed) | — | new operation |
| Odoo force-reprint | operator only, derived key | — | new operation |
| reprint (gateway console) | operator only, `gw-reprint:{id}:{n}` | unique index collapses double-click | new job |

## Delivery semantics (proven, not claimed)
At-least-once physical execution with honest unknown-outcome accounting. Exactly-once is explicitly NOT claimed anywhere (agent ledger + gateway fencing + sweep/lease design all assume duplicates happen).
