-- Enforce tenant ownership across runtime relationships.
-- These constraints make cross-tenant references impossible even when an
-- application query accidentally omits a tenant predicate.
ALTER TABLE "printers"
  DROP CONSTRAINT IF EXISTS "printers_agent_id_agents_id_fk";
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "discovery_sessions"
  DROP CONSTRAINT IF EXISTS "discovery_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_discovery_id_discovery_sessions_id_fk";
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_agent_id_agents_id_fk";
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_provisioned_printer_id_printers_id_fk";
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_api_key_id_api_keys_id_fk";
--> statement-breakpoint















--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint

--> statement-breakpoint
