-- Gateway is runtime-only. Odoo remains the source of truth for companies,
-- branches, destinations, document types, and print bindings.
-- Preserve only the destination label already stored on print jobs, then
-- remove every duplicated business entity and branch relationship.

ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "destination" text;

DO $$
BEGIN
  IF to_regclass('public.destinations') IS NOT NULL THEN
    EXECUTE $q$
      UPDATE "print_jobs" j
      SET "destination" = COALESCE(j."destination", d."name")
      FROM "destinations" d
      WHERE j."destination_id" = d."id"
        AND j."destination" IS NULL
    $q$;
  END IF;
END $$;

ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_destination_id_destinations_id_fk";
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_branch_id_branches_id_fk";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_branch_id_branches_id_fk";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_local_network_id_local_networks_id_fk";
ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_branch_id_branches_id_fk";
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_branch_id_branches_id_fk";
ALTER TABLE "discovery_sessions" DROP CONSTRAINT IF EXISTS "discovery_sessions_branch_id_branches_id_fk";
ALTER TABLE "discovered_devices" DROP CONSTRAINT IF EXISTS "discovered_devices_branch_id_branches_id_fk";

DROP INDEX IF EXISTS "print_jobs_destination_id_idx";
DROP INDEX IF EXISTS "print_jobs_branch_id_idx";
DROP INDEX IF EXISTS "print_jobs_branch_idempotency_idx";
DROP INDEX IF EXISTS "agents_branch_id_idx";
DROP INDEX IF EXISTS "agents_local_network_id_idx";
DROP INDEX IF EXISTS "printers_branch_id_idx";
DROP INDEX IF EXISTS "api_keys_branch_id_idx";
DROP INDEX IF EXISTS "discovery_sessions_branch_id_idx";
DROP INDEX IF EXISTS "discovered_devices_branch_id_idx";

ALTER TABLE "print_jobs" DROP COLUMN IF EXISTS "destination_id";
ALTER TABLE "print_jobs" DROP COLUMN IF EXISTS "branch_id";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "branch_id";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "local_network_id";
ALTER TABLE "printers" DROP COLUMN IF EXISTS "branch_id";
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "branch_id";
ALTER TABLE "discovery_sessions" DROP COLUMN IF EXISTS "branch_id";
ALTER TABLE "discovered_devices" DROP COLUMN IF EXISTS "branch_id";

DROP TABLE IF EXISTS "printer_bindings" CASCADE;
DROP TABLE IF EXISTS "document_types" CASCADE;
DROP TABLE IF EXISTS "destinations" CASCADE;
DROP TABLE IF EXISTS "local_networks" CASCADE;
DROP TABLE IF EXISTS "branches" CASCADE;
