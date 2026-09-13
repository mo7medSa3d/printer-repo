-- Correlate end-to-end print latency without putting secrets or payloads into logs.
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_request_id_idx" ON "print_jobs" USING btree ("request_id");
