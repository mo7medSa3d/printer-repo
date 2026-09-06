# Agent ↔ Gateway WebSocket protocol

Implementation: `src/server/ws.ts` (gateway, attached to the HTTP server in `server.ts`) and
`agent/internal/agent/agent.go` (`connectWebSocket`, `handleWSMessages`, `sendJobAck`).

## 1. Connection

| Property | Value |
|---|---|
| URL | `wss://<gateway>/api/agent/ws` (`ws://` in local development) |
| Auth | `Authorization: Bearer <agentId>:<secret>` on the HTTP upgrade request |
| Rejection | `HTTP/1.1 401 Unauthorized` with a JSON body, socket destroyed |
| Keepalive | Gateway pings every 30 s; a client that misses a pong is terminated |
| Frame limit | 64 KiB (`maxPayload`) — agent→gateway frames are tiny control messages |
| Fan-out | The gateway tracks `Map<agentId, Set<socket>>`; a job is written to **one** open socket (the newest) so a second socket of the same agent is not a duplicate delivery |
| Plain HTTP GET | `GET /api/agent/ws` returns `426 Upgrade Required` (`src/app/api/agent/ws/route.ts`) |

Only the agent uses a WebSocket. The desktop manager and dashboard poll over HTTPS.

Reconnect (agent side): jittered exponential backoff starting at 5 s, doubling to a 60 s
maximum, reset to 5 s after a successful connection.

## 2. Gateway → Agent: `print_job`

Sent only after the job has been claimed (`status='claimed'` committed). Exact shape produced by
`buildJobEnvelope`:

```json
{
  "type": "print_job",
  "job": {
    "id": "job_V1StGXR8Z5jd",
    "branchId": "branch_cairo",
    "agentId": "agt_7f3c",
    "printerId": "printer_spooler_9ab1",
    "destinationId": "dest_pos_1",
    "documentType": "receipt",
    "status": "claimed",
    "payload": { "type": "pdf", "encoding": "base64", "data": "JVBERi0xLjQK…" },
    "expiresAt": "2026-09-01T12:00:00.000Z",
    "retries": 0
  },
  "id": "job_V1StGXR8Z5jd",
  "printerId": "printer_spooler_9ab1",
  "payload": { "type": "pdf", "encoding": "base64", "data": "JVBERi0xLjQK…" },
  "expiresAt": "2026-09-01T12:00:00.000Z"
}
```

The flat `id` / `printerId` / `payload` / `expiresAt` keys are aliases retained for backwards
compatibility with older agents. The agent parser accepts both the current envelope and a legacy
bare job object with an `id`. Any other `type` is ignored.

## 3. Agent → Gateway: `job_ack`

```json
{ "type": "job_ack", "jobId": "job_V1StGXR8Z5jd" }
```

* Sent immediately when the job is received, before printing.
* Sent for duplicates too, including a job the agent will not print because it already completed locally.
* Effect on the gateway: `acked_at = now()` and `delivered_at = COALESCE(delivered_at, now())`.
* It never changes logical job status and never means paper came out.
* Writes are serialised with an agent-side mutex and use a 10 s write deadline.

## 4. Ordering guarantees

```text
claim transaction COMMIT → socket write → delivered_at → job_ack → acked_at
```

The agent cannot observe a job that is still `queued`: the claim is committed before the first byte
is written. "Sent" is therefore never confused with "executed".

## 5. Delivery failure

`claimAndPushJobToAgent` returns one of:

| Outcome | Meaning | Row state afterwards |
|---|---|---|
| `delivered` | Claimed and written to a socket | `claimed`, `delivered_at` set |
| `no_socket` | Agent not connected — nothing was claimed | unchanged `queued` |
| `not_claimable` | Already claimed/terminal/expired or lost the race | unchanged `queued`/terminal |
| `requeued` | Claim taken, socket write failed, claim released | `queued`, same job id |
| `failed` | Delivery budget exhausted | `failed` with explicit delivery error |

`MAX_DELIVERY_ATTEMPTS = 5` (`src/lib/job-delivery.ts`).

## 6. Polling fallback and recovery leases

* When the socket is down, the agent polls `GET /api/agent/jobs` every 10 s.
* While the socket is up, the agent still polls every third tick (~30 s) as a safety net for a lost
  WebSocket delivery.
* **Delivery lease:** a silent `claimed` job may be reclaimed after `STALE_CLAIM_SECONDS` (90 s).
  This is a transport-recovery lease only; it does not classify physical printing.
* **Execution lease:** a silent `printing` job uses the separate `STALE_PRINTING_SECONDS` backstop
  (10 minutes). It is intentionally longer than the normal agent print timeout and is refreshed by
  heartbeat keep-alives while the agent legitimately holds the job.
* A stale `printing` recovery records an explicit interruption/timeout marker. It does not silently
  claim that the printer definitely produced no output. The derived physical outcome is `unknown`.
* Retries use the same `jobId`; no recovery path creates a second logical job.

## 7. Duplicate and crash semantics

* Gateway side: a second push for the same job is not claimable and is not sent as a second logical delivery.
* Agent side: `dispatchJob` drops a job already in flight, and `processJob` re-reports the stored terminal
  result for a job already succeeded locally instead of physically printing it again.
* A process crash while the printer is active yields `AGENT_RESTART_DURING_PRINT`; the physical output is
  **UNKNOWN** (full, partial, or none).
* `agent.reprint_after_crash=false` is the safe default and prevents automatic reprinting of the interrupted
  operation. `true` explicitly opts into at-least-once reprinting and possible duplicate paper.
* The protocol does not claim exactly-once physical printing.

## 8. Tests

| Behaviour | Test |
|---|---|
| Claim committed before socket write; envelope carries `status: "claimed"` | `tests/ws-claim-delivery.test.ts` |
| ACK records receipt without changing status | `tests/ws-claim-delivery.test.ts` |
| Undelivered claim is requeued / budget exhausted / delivery lease recovery | `tests/ws-claim-delivery.test.ts` |
| Duplicate push and terminal duplicate protection | `tests/ws-claim-delivery.test.ts`, `agent/internal/agent/ws_delivery_test.go` |
| Lifecycle fencing | `tests/lifecycle-delivery.test.ts` |
| Unknown physical outcome after stale printing/crash | `tests/job-maintenance.test.ts`, `tests/physical-outcome.test.ts`, agent crash tests |
| Migration and multi-instance DB behaviour | `tests/migration-upgrade.integration.test.ts`, `tests/multi-instance-gateway.test.ts` |

These tests require Node dependencies and, for database-backed cases, PostgreSQL; see [TESTING.md](TESTING.md).
