# Phase 24 - Scale / Noisy Neighbors

## Verification
- Investigated `src/lib/job-delivery.ts` and `src/lib/print-job-service.ts` for scale management caps.
- Found hard caps at `MAX_AGENT_IN_FLIGHT_JOBS = 500` and `MAX_AGENT_QUEUED_JOBS = 1000`.
- Rate limiting is structurally separated into API levels (`PRINT_JOB_RATE_LIMIT_PER_MINUTE`) alongside global Tenant Level metrics `max_jobs_per_minute` (checked during Phase 22).

## Findings
- Multi-tenant scaling limits (noisy neighbor prevention) are deeply embedded directly into the Postgres execution routines using transactions and row constraints (`pg_advisory_xact_lock`).
- There are no runaway memory queues in JS, as all state is backed gracefully by database locks that shed requests appropriately when saturated (`AgentQueuedJobsFullError`).

## Actionable
- Validated. Proceeding to Phase 25.
