-- Execution fencing for delivery attempts + the explicit payload protocol
-- contract enforced at the database boundary.
--
-- Phase 9: every claim (poll or WebSocket) mints a fresh claim_token. Agents
-- must echo it on status updates, so a stale worker (an attempt whose lease
-- expired and was reclaimed) is rejected by a DB-enforced ownership predicate
-- instead of an in-memory convention.
--
-- Phase 3: print_jobs.payload must obey the same type/protocol contract that
-- validatePrintJobPayload enforces at the API boundary:
--   type=raw     -> protocol IN (raw, escpos, zpl, tspl)  (explicit, never inferred)
--   type=escpos  -> protocol = escpos
--   type=pdf     -> protocol absent/null
--   type=image   -> protocol absent/null
-- The constraint is added NOT VALID because pre-existing rows are not
-- rewritten by this migration; every new write is checked by the database.

ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "claim_token" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_payload_contract_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_payload_contract_check
      CHECK (
        jsonb_typeof(payload) = 'object'
        AND (
          -- COALESCE keeps the predicate two-valued: a NULL/absent protocol
          -- must FAIL the raw/escpos branches, never evaluate to UNKNOWN
          -- (which a CHECK constraint silently accepts).
          (payload->>'type' = 'raw' AND COALESCE(payload->>'protocol', '') IN ('raw', 'escpos', 'zpl', 'tspl'))
          OR (payload->>'type' = 'escpos' AND COALESCE(payload->>'protocol', '') = 'escpos')
          OR (payload->>'type' = 'pdf' AND COALESCE(payload->>'protocol', '') = '')
          OR (payload->>'type' = 'image' AND COALESCE(payload->>'protocol', '') = '')
        )
      ) NOT VALID;
  END IF;
END $$;
