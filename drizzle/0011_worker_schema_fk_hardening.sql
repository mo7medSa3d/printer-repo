-- Namespace-safe FK hardening.
-- Earlier generated migrations qualified referenced tables with "public".
-- That is correct for the production schema but breaks isolated Vitest schemas:
-- tables live in test_<worker>, while their FKs still point at public.*.
-- Recreate cross-table FKs against the current search_path so every schema is self-contained.

ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_agent_id_agents_id_fk";
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_printer_id_printers_id_fk";
ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_agent_id_agents_id_fk";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_branch_id_branches_id_fk";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_local_network_id_local_networks_id_fk";
ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_branch_id_branches_id_fk";
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_branch_id_branches_id_fk";
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_destination_id_destinations_id_fk";
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_branch_id_branches_id_fk";
ALTER TABLE "destinations" DROP CONSTRAINT IF EXISTS "destinations_branch_id_branches_id_fk";
ALTER TABLE "local_networks" DROP CONSTRAINT IF EXISTS "local_networks_branch_id_branches_id_fk";
ALTER TABLE "printer_bindings" DROP CONSTRAINT IF EXISTS "printer_bindings_branch_id_branches_id_fk";
ALTER TABLE "printer_bindings" DROP CONSTRAINT IF EXISTS "printer_bindings_destination_id_destinations_id_fk";
ALTER TABLE "printer_bindings" DROP CONSTRAINT IF EXISTS "printer_bindings_printer_id_printers_id_fk";
ALTER TABLE "document_types" DROP CONSTRAINT IF EXISTS "document_types_branch_id_branches_id_fk";

ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk"
  FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printers"
  ADD CONSTRAINT "printers_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_local_network_id_local_networks_id_fk"
  FOREIGN KEY ("local_network_id") REFERENCES "local_networks"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_destination_id_destinations_id_fk"
  FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "destinations"
  ADD CONSTRAINT "destinations_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "local_networks"
  ADD CONSTRAINT "local_networks_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings"
  ADD CONSTRAINT "printer_bindings_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings"
  ADD CONSTRAINT "printer_bindings_destination_id_destinations_id_fk"
  FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings"
  ADD CONSTRAINT "printer_bindings_printer_id_printers_id_fk"
  FOREIGN KEY ("printer_id") REFERENCES "printers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "document_types"
  ADD CONSTRAINT "document_types_branch_id_branches_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE no action ON UPDATE no action;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'printers' AND column_name = 'branch_id'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM printers p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.branch_id IS DISTINCT FROM a.branch_id
    ) THEN
      RAISE EXCEPTION 'Migration blocked: printer/agent branch mismatch exists while removing legacy printer.branch_id.';
    END IF;
    ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_branch_id_branches_id_fk";
    DROP INDEX IF EXISTS "printers_branch_id_idx";
    ALTER TABLE "printers" DROP COLUMN "branch_id";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'printers' AND column_name = 'type'
  ) THEN
    ALTER TABLE "printers" DROP COLUMN "type";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'printers' AND column_name = 'enabled'
  ) THEN
    ALTER TABLE "printers" DROP COLUMN "enabled";
  END IF;
END $$;
