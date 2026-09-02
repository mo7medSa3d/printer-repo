-- 0007: runtime lifecycle support + auth rate-limit retention
--
-- Idempotent: every statement is guarded, so replaying this file on an
-- already-migrated database is a no-op.

-- ---------------------------------------------------------------------------
-- Auth rate-limit retention.
--
-- Cleanup deletes buckets that can no longer affect a decision, selecting on
-- (locked_until, updated_at). Without an index that is a sequential scan over a
-- table that grows with every distinct attacker IP.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_at_idx
  ON auth_rate_limits (updated_at);

-- ---------------------------------------------------------------------------
-- Routing determinism.
--
-- Ties on `priority` within one routing key are broken by binding id, so the
-- lookup order is (branch, destination, document_type, priority, id). Extending
-- the existing routing index with `id` lets PostgreSQL return rows already in
-- the exact order the router wants, instead of sorting them afterwards.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS printer_bindings_routing_deterministic_idx
  ON printer_bindings (branch_id, destination_id, document_type, priority, id);

-- ---------------------------------------------------------------------------
-- Printer ownership lookup (Branch -> Agent -> Printer).
--
-- Every branch derivation joins printers to agents on agent_id, so this index
-- is load-bearing now that printers.branch_id no longer exists.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS printers_agent_id_idx ON printers (agent_id);

-- ---------------------------------------------------------------------------
-- Lifecycle.
--
-- 'retired' is a new value for the existing agents.status / printers.status
-- columns (plain text, no enum type to alter), so no DDL is required. This
-- comment records the supported vocabulary explicitly:
--
--   agents.status   : online | offline | disabled | retired
--   printers.status : online | offline | busy | error | unknown | retired
--
-- Retirement is a state transition, never a delete: print_jobs.agent_id and
-- print_jobs.printer_id are NOT NULL foreign keys, so deleting a runtime entity
-- would mean destroying print history.
-- ---------------------------------------------------------------------------

-- agents.secret becomes NULLable so retiring an agent can revoke its credential
-- without inventing a sentinel hash that some code path might accidentally match.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'secret' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE agents ALTER COLUMN secret DROP NOT NULL;
  END IF;
END $$;

-- Fast "which printers belong to retired/disabled agents" and lifecycle filters.
CREATE INDEX IF NOT EXISTS agents_status_idx ON agents (status);
