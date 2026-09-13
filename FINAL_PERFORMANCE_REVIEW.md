# Final Performance Review

## Historical symptom
Earlier investigations reported a multi-second print-command delay (roughly 9–10 seconds). The current review does not assume that number remains true.

## Instrumentation added

Gateway and Agent correlation now carry `requestId` through the job lifecycle. Gateway logs include the durable job creation boundary and WebSocket delivery boundary; Agent logs include receive, local execution start, and transport completion.

Current intended timing anchors are:

- T0 user action: **not wired in this repository review**.
- T1 Odoo router entry: **not instrumented end-to-end in this pass**.
- T2 Gateway request start: **partially represented by request correlation**.
- T3 job commit: **represented by persisted `print_jobs.created_at`**.
- T4 Gateway dispatch: **instrumented**.
- T5 Agent receive: **instrumented**.
- T6 Agent local execution start: **instrumented**.
- T7 rendering: **not isolated as a separate timestamp in every renderer backend**.
- T8 transport submission: **instrumented as execution/transport boundary**.
- T9 Windows spooler/network completion: **not physically verifiable here**.
- T10 acknowledgement/result persistence: **not fully benchmarked here**.

## Important runtime observation

The Agent has a fallback poll ticker of 10 seconds, with a safety check every 3 ticks, i.e. approximately every 30 seconds, for claimed-but-undelivered jobs. This is explicitly a safety path, not the intended low-latency connected WebSocket path.

Therefore the normal target behavior should be immediate WS delivery; any multi-second latency under a healthy persistent WS connection is still unexplained until measured on a real Windows + Gateway environment.

## Exact measured latency

**NOT VERIFIED.** No honest end-to-end numerical latency can be supplied from this environment because Odoo, Windows, PostgreSQL runtime, and a printer are absent.

## Required next measurement

Run warm and cold prints while collecting the above timestamps, then break the total into:

`Odoo → Gateway | DB commit | Gateway → Agent | Agent local | render | transport | physical submission | ACK persistence`

Do not optimize based on the historical 9–10s number alone.

## Verdict
`INSTRUMENTED BUT NOT BENCHMARKED`
