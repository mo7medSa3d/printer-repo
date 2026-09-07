-- Print jobs are installation-scoped by the authenticated Odoo API key.
-- Existing jobs must be associated before the stricter NOT NULL constraint can be applied;
-- rows with no installation identity cannot be safely exposed through the Odoo status API.

ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "api_key_id" text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'print_jobs'
      AND column_name = 'api_key_id'
      AND is_nullable = 'YES'
  ) THEN
    -- There is no trustworthy historical mapping from a job to an API key.
    -- Keep such rows inaccessible to installation-scoped Odoo status reads until
    -- they are explicitly reconciled by an operator/migration specific to that deployment.
    NULL;
  END IF;
END $$;

ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_api_key_id_api_keys_id_fk";
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_api_key_id_api_keys_id_fk"
  FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id");

DROP INDEX IF EXISTS "print_jobs_idempotency_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_idempotency_unique"
  ON "print_jobs" ("api_key_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND "api_key_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "print_jobs_api_key_id_idx"
  ON "print_jobs" ("api_key_id");
