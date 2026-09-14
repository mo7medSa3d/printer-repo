const fs = require('fs');

let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');
file = file.replace(
    'ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_tenant_id_agent_id_agents_tenant_id_id_fk";\nALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_agent_id_agents_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;\nALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk";\nALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk";\nALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "public"."printers" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;\nALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);
// I previously removed these NOT VALID constraints, but this migration tests composite keys explicitly!
file += `
ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_discovery_id_fk" FOREIGN KEY ("tenant_id", "discovery_id") REFERENCES "public"."discovery_sessions" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk" FOREIGN KEY ("tenant_id", "provisioned_printer_id") REFERENCES "public"."printers" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_api_key_id_api_keys_fk" FOREIGN KEY ("tenant_id", "api_key_id") REFERENCES "public"."api_keys" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
`;

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
