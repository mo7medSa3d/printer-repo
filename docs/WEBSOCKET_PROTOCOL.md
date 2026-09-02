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

Only the agent uses a WebSocket. The desktop manager and the dashboard poll over HTTPS.

Reconnect (agent side): jittered exponential backoff starting at 5 s, doubling to a 60 s
maximum, reset to 5 s after a successful connection.

## 2. Gateway → Agent: `print_job`

Sent **only after** the job has been claimed (`status='claimed'` committed). Exact shape
produced by `buildJobEnvelope`:

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

The flat `id` / `printerId` / `payload` / `expiresAt` keys are aliases kept so an older agent
build (which read the job fields directly off the message) still works against a new gateway.
The agent parser accepts both shapes (`extractJobFromWSMessage`): an envelope with
`type: "print_job"`, or a legacy bare job object with an `id`. Any other `type` is ignored.

No other message type is sent by the gateway today; in particular no jobs are pushed on
connect, and there is no live printer-probe command.

## 3. Agent → Gateway: `job_ack`

```json
{ "type": "job_ack", "jobId": "job_V1StGXR8Z5jd" }
```

* Sent immediately when the job is received, **before** printing.
* Sent for duplicates too, including a job the agent will not print because it already
  completed locally — so the gateway can distinguish "lost delivery" from "duplicate".
* Effect on the gateway (`recordJobAck`): `acked_at = now()` and `delivered_at =
  COALESCE(delivered_at, now())`.
* What it does **not** do: it never changes `status`, never counts as progress, and never
  means paper came out. An ack for an unknown job id is logged and ignored.
* Writes are serialised with a mutex on the agent (gorilla/websocket allows one writer) and
  use a 10 s write deadline.

Any other agent→gateway frame is ignored (it only refreshes the liveness flag).
Non-JSON frames are dropped silently.

## 4. Ordering guarantees

```
claim transaction COMMIT   →   socket write   →   delivered_at   →   job_ack   →   acked_at
```

The agent can never observe a job that is still `queued`: the claim is committed before the
first byte is written. "Sent" is therefore never confused with "executed".

## 5. Delivery failure

`claimAndPushJobToAgent` returns one of:

| Outcome | Meaning | Row state afterwards |
|---|---|---|
| `delivered` | Claimed and written to a socket | `claimed`, `delivered_at` set, `delivery_attempts + 1` |
| `no_socket` | Agent not connected — nothing was claimed | unchanged `queued` |
| `not_claimable` | Already claimed/terminal/expired or lost the race | unchanged |
| `requeued` | Claim taken, socket write failed, claim released | `queued`, `claimed_at = NULL`, same job id |
| `failed` | As above but `delivery_attempts >= 5` | `failed` with an explicit error |

`MAX_DELIVERY_ATTEMPTS = 5` (`src/lib/job-delivery.ts`).

## 6. Polling fallback and stale-claim recovery

* When the socket is down, the agent polls `GET /api/agent/jobs` every 10 s. The response
  rows are already `claimed`.
* While the socket is up, the agent still polls every third tick (~30 s) as a safety net
  (`wsSafetyPollEvery` in `agent/internal/agent/agent.go`). This is what recovers a job that
  was claimed for WebSocket delivery but never arrived — without it the row would sit
  `claimed` until the agent happened to disconnect.
* The poll endpoint reclaims `claimed`/`printing` rows that have been silent for
  `90 s` (`STALE_CLAIM_SECONDS` == `CLAIM_LEASE_SECONDS`), incrementing `retries` and
  re-delivering **the same job id**. After `retries >= 5` the job is failed permanently.

## 7. Duplicate delivery behaviour

* Gateway side: a second push for the same job returns `not_claimable` and sends nothing.
* Agent side: `dispatchJob` drops a job that is already in flight; `processJob` re-reports
  the stored terminal result for a job that already succeeded locally instead of printing it
  again. Both paths still send `job_ack`.

## 8. Tests

| Behaviour | Test |
|---|---|
| Claim committed before the socket write; envelope carries `status: "claimed"` | `tests/ws-claim-delivery.test.ts` — "Test 1" |
| `job_ack` records receipt without changing status | same file — "Test 1b" |
| A fast agent cannot PATCH out of `queued` | "Test 2" |
| Undelivered claim is requeued under the same id / fails after 5 attempts / stale lease reclaim | "Test 3a–3d" |
| Duplicate push delivers once | "Test 4" |
| Concurrent claimers / concurrent polls | "Test 5", "Test 5b" |
| Terminal job is never re-delivered | "Test 6" |
| Envelope parsing (envelope + legacy), acks on duplicates | `agent/internal/agent/ws_delivery_test.go` |

These tests require the Node dependencies and, for database-backed cases, a real PostgreSQL instance; see [TESTING.md](TESTING.md). They were not executable in this workspace.
