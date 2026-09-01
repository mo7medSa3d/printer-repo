-- Idempotency: store original key for tracing and enforce (branch_id, idempotency_key) uniqueness.
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;

-- Backfill: existing jobs have no idempotency key (null) — no constraint violation.

-- Unique index enforces idempotency per branch (nullable keys are distinct in PG,
-- so only non-null duplicates are rejected — exactly what we want: repeated
-- retries with same key collide, but jobs without a key remain unrestricted).
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_branch_idempotency_unique" ON "print_jobs" USING btree ("branch_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- Index for fast lookup during idempotent POST (where branch_id=:branch and idempotency_key=:key)
CREATE INDEX IF NOT EXISTS "print_jobs_branch_idempotency_idx" ON "print_jobs" USING btree ("branch_id", "idempotency_key");

-- Tighten NOT NULL that were backfilled in 0001 but left nullable in schema drift.
-- Agents/printers/print_jobs branch_id should be NOT NULL (backfilled to 'default').
-- Using DO block to avoid failure if column already NOT NULL.
DO $$ BEGIN
  BEGIN
    ALTER TABLE "agents" ALTER COLUMN "branch_id" SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE "printers" ALTER COLUMN "branch_id" SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE "print_jobs" ALTER COLUMN "branch_id" SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;
