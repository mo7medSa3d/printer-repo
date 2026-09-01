-- Claim-before-delivery bookkeeping for the Agent WebSocket protocol.
--
-- Before this migration the gateway pushed a job over the WebSocket and only
-- then tried to move it queued -> claimed, so a fast agent could report
-- printing/success against a still-queued row (rejected with 409) while the
-- paper was already out. The job is now claimed inside a transaction BEFORE
-- it is handed to an agent; these columns make the delivery itself auditable
-- and let an undelivered claim be recovered without minting a new job id.
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp;
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "acked_at" timestamp;

-- Recovery sweeps look for claimed-but-undelivered / stale-claimed rows.
CREATE INDEX IF NOT EXISTS "print_jobs_claimed_at_idx" ON "print_jobs" ("status", "claimed_at");
