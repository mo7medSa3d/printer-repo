-- Enforce tenant ownership across runtime relationships.
-- These constraints make cross-tenant references impossible even when an
-- application query accidentally omits a tenant predicate.
ALTER TABLE "printers"
  DROP CONSTRAINT IF EXISTS "printers_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "printers"
  ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk"
  FOREIGN KEY ("tenant_id", "agent_id")
  REFERENCES "public"."agents" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovery_sessions"
  DROP CONSTRAINT IF EXISTS "discovery_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "discovery_sessions"
  ADD CONSTRAINT "discovery_sessions_tenant_id_agent_id_agents_fk"
  FOREIGN KEY ("tenant_id", "agent_id")
  REFERENCES "public"."agents" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_discovery_id_discovery_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  ADD CONSTRAINT "discovered_devices_tenant_id_discovery_id_fk"
  FOREIGN KEY ("tenant_id", "discovery_id")
  REFERENCES "public"."discovery_sessions" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk"
  FOREIGN KEY ("tenant_id", "agent_id")
  REFERENCES "public"."agents" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  DROP CONSTRAINT IF EXISTS "discovered_devices_provisioned_printer_id_printers_id_fk";
--> statement-breakpoint
ALTER TABLE "discovered_devices"
  ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk"
  FOREIGN KEY ("tenant_id", "provisioned_printer_id")
  REFERENCES "public"."printers" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "print_jobs"
  ADD CONSTRAINT "print_jobs_tenant_id_api_key_id_api_keys_fk"
  FOREIGN KEY ("tenant_id", "api_key_id")
  REFERENCES "public"."api_keys" ("tenant_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
