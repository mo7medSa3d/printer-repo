const fs = require('fs');
let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

// Completely remove the ADD CONSTRAINT from this migration. They are getting re-added incorrectly because
// drizzle doesn't seem to natively understand composite foreign keys when the unique constraint is missing on the target table
file = file.replace(/ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk" FOREIGN KEY \("tenant_id", "agent_id"\) REFERENCES "public"\."agents" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');
file = file.replace(/ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_agent_id_agents_fk" FOREIGN KEY \("tenant_id", "agent_id"\) REFERENCES "public"\."agents" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');
file = file.replace(/ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_discovery_id_fk" FOREIGN KEY \("tenant_id", "discovery_id"\) REFERENCES "public"\."discovery_sessions" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');
file = file.replace(/ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk" FOREIGN KEY \("tenant_id", "agent_id"\) REFERENCES "public"\."agents" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');
file = file.replace(/ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk" FOREIGN KEY \("tenant_id", "provisioned_printer_id"\) REFERENCES "public"\."printers" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');
file = file.replace(/ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_api_key_id_api_keys_fk" FOREIGN KEY \("tenant_id", "api_key_id"\) REFERENCES "public"\."api_keys" \("tenant_id", "id"\) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n--> statement-breakpoint\n/g, '');

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
