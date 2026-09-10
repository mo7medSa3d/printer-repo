CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_internal_idempotency_unique"
  ON "print_jobs" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND "api_key_id" IS NULL;
