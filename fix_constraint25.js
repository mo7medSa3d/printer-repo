const fs = require('fs');
let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

file += `
ALTER TABLE "printers" DROP CONSTRAINT IF EXISTS "printers_tenant_id_agent_id_agents_tenant_id_id_fk";
ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_agent_id_agents_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk";
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk";
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "printer_id") REFERENCES "public"."printers" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
`;

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
