-- Pairing-code collision guard (audit P2-02).
--
-- A pairing code is the ONLY identity a not-yet-registered agent holds, so
-- two agents sharing one pending code hash breaks the pairing contract: the
-- register route looks the code up globally (no tenant is provable before
-- authentication), and the first registrant would consume the other's code.
-- The generator emits 32^6 possibilities (no cross-code check at insert
-- time), so enforce collision-freedom at the database boundary instead.
--
-- Partial index: consumed codes are NULLed on registration (register route
-- clears pairing_code_hash), so only PENDING codes participate. Multiple
-- NULLs are permitted; two different live codes never share a hash.
--
-- Upgrade behavior: if a legacy database somehow holds two rows with the
-- same pending hash, this migration aborts LOUDLY with operator
-- instructions instead of deleting or guessing ownership (same fail-closed
-- policy as 0029's tenant backfill). Fresh installs trivially pass.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT pairing_code_hash
    FROM agents
    WHERE pairing_code_hash IS NOT NULL
    GROUP BY pairing_code_hash
    HAVING COUNT(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'agents holds % pending pairing-code-hash collision(s). Regenerate the affected pairing codes (disable/re-enable the agent, which mints a fresh single-use code) and re-run the migration; ownership is never resolved automatically.', dup_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_pairing_code_hash_pending_unique"
  ON "agents" USING btree ("pairing_code_hash") WHERE pairing_code_hash IS NOT NULL;
