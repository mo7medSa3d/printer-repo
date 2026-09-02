-- ============================================================================
-- 0006 — Printer branch ownership is derived through the Agent
--
--   BEFORE:  Branch → Agent → Printer   AND   Printer → Branch (redundant)
--   AFTER:   Branch → Agent → Printer   (single source of truth)
--
-- `printers.branch_id` duplicated ownership already expressed by
-- `printers.agent_id → agents.branch_id`, which made states such as
-- "agent in Branch A owns a printer stamped Branch B" representable.
--
-- This migration is PRODUCTION SAFE and FAILS LOUDLY:
--
--   1. every printer must reference an existing agent (no orphans);
--   2. `agents.branch_id` must be present and reference an existing branch;
--   3. every legacy `printers.branch_id` must already equal its agent's
--      branch. NOTHING is auto-reassigned across branches — a mismatch aborts
--      the migration with a precise, actionable report naming the printer, its
--      stored branch, its agent, and the agent's branch;
--   4. only after 1–3 hold is the redundant column (and its index) dropped.
--
-- It is idempotent: re-running after a successful apply is a no-op.
-- It is transactional: any raised exception rolls the whole thing back and the
-- old column survives untouched, so a failed upgrade is always recoverable.
--
-- OPERATOR REMEDIATION for a step-3 failure — pick ONE per offending printer,
-- deliberately, then re-run this migration:
--   a) move the AGENT to the printer's branch
--        UPDATE agents SET branch_id = '<branch>' WHERE id = '<agent>';
--      (moves every printer of that agent — that is the new, intended semantics)
--   b) move the PRINTER to an agent that is already in the right branch
--        UPDATE printers SET agent_id = '<agent-in-correct-branch>' WHERE id = '<printer>';
--   c) accept the agent's branch as authoritative
--        UPDATE printers SET branch_id = (SELECT branch_id FROM agents WHERE agents.id = printers.agent_id)
--        WHERE id = '<printer>';
--   d) retire the record
--        DELETE FROM printer_bindings WHERE printer_id = '<printer>';  -- check print_jobs first
--        DELETE FROM printers WHERE id = '<printer>';
-- Never silently pick one of these for the operator: each moves real hardware
-- between real business locations.
-- ============================================================================

DO $$
DECLARE
  has_branch_col boolean;
  bad_count      integer;
  report         text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'printers' AND column_name = 'branch_id'
  ) INTO has_branch_col;

  -- ---------------------------------------------------------------- step 1
  -- Orphaned printers: agent_id NULL or pointing at a missing agent. Without
  -- an agent the printer would have NO branch at all after this migration.
  SELECT count(*) INTO bad_count
  FROM printers p
  LEFT JOIN agents a ON a.id = p.agent_id
  WHERE p.agent_id IS NULL OR a.id IS NULL;

  IF bad_count > 0 THEN
    SELECT string_agg(format('  printer=%s (agent_id=%s -> MISSING)', p.id, coalesce(p.agent_id, 'NULL')), E'\n')
      INTO report
    FROM printers p
    LEFT JOIN agents a ON a.id = p.agent_id
    WHERE p.agent_id IS NULL OR a.id IS NULL;

    RAISE EXCEPTION
      'MIGRATION 0006 ABORTED: % printer(s) have no valid agent. A printer''s branch is derived through its agent, so an agent-less printer cannot be migrated.%s%s',
      bad_count, E'\n', report
      USING HINT = 'Assign each printer to an agent in the correct branch (UPDATE printers SET agent_id = ...) or delete the stale printer, then re-run.';
  END IF;

  -- ---------------------------------------------------------------- step 2
  -- Agents must carry a branch: it becomes the ONLY branch authority.
  SELECT count(*) INTO bad_count
  FROM agents a
  LEFT JOIN branches b ON b.id = a.branch_id
  WHERE a.branch_id IS NULL OR b.id IS NULL;

  IF bad_count > 0 THEN
    SELECT string_agg(format('  agent=%s (branch_id=%s -> MISSING)', a.id, coalesce(a.branch_id, 'NULL')), E'\n')
      INTO report
    FROM agents a
    LEFT JOIN branches b ON b.id = a.branch_id
    WHERE a.branch_id IS NULL OR b.id IS NULL;

    RAISE EXCEPTION
      'MIGRATION 0006 ABORTED: % agent(s) have no valid branch. Agent is the sole owner of branch context.%s%s',
      bad_count, E'\n', report
      USING HINT = 'Set a valid agents.branch_id for each listed agent, then re-run.';
  END IF;

  -- ---------------------------------------------------------------- step 3
  -- Reconcile legacy data: the stored printer branch must already agree with
  -- the agent's branch. Disagreement is a real-world ambiguity (which location
  -- is the hardware actually in?) and is never resolved automatically.
  IF has_branch_col THEN
    EXECUTE $q$
      SELECT count(*)
      FROM printers p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.branch_id IS DISTINCT FROM a.branch_id
    $q$ INTO bad_count;

    IF bad_count > 0 THEN
      EXECUTE $q$
        SELECT string_agg(
          format('  printer=%s printer.branch_id=%s agent=%s agent.branch_id=%s',
                 p.id, coalesce(p.branch_id, 'NULL'), a.id, coalesce(a.branch_id, 'NULL')),
          E'\n' ORDER BY p.id)
        FROM printers p
        JOIN agents a ON a.id = p.agent_id
        WHERE p.branch_id IS DISTINCT FROM a.branch_id
      $q$ INTO report;

      RAISE EXCEPTION
        'MIGRATION 0006 ABORTED: % printer(s) disagree with their agent about the owning branch. Refusing to silently reassign hardware between branches.%s%s',
        bad_count, E'\n', report
        USING HINT = 'Resolve each conflict explicitly (see the remediation options in drizzle/0006_printer_branch_via_agent.sql), then re-run.';
    END IF;
  END IF;

  -- ---------------------------------------------------------------- step 4
  -- Integrity established: drop the redundant column and its index.
  IF has_branch_col THEN
    EXECUTE 'DROP INDEX IF EXISTS printers_branch_id_idx';
    EXECUTE 'ALTER TABLE printers DROP COLUMN branch_id';
    RAISE NOTICE 'MIGRATION 0006: printers.branch_id dropped; printer branch is now derived via printer.agent_id -> agents.branch_id';
  ELSE
    RAISE NOTICE 'MIGRATION 0006: printers.branch_id already absent — nothing to do';
  END IF;
END
$$;

-- Hard guarantees for the new model -----------------------------------------
-- agent_id must stay NOT NULL and must keep referencing a real agent: it is
-- now the ONLY path from a printer to its branch.
ALTER TABLE "printers" ALTER COLUMN "agent_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "printers"
      ADD CONSTRAINT "printers_agent_id_agents_id_fk"
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
  END IF;
END
$$;

-- The agent index is the primary access path for "all printers in a branch"
-- (branches → agents → printers), so keep it and make the join cheap.
CREATE INDEX IF NOT EXISTS "printers_agent_id_idx" ON "printers" ("agent_id");
CREATE INDEX IF NOT EXISTS "agents_branch_id_idx" ON "agents" ("branch_id");
