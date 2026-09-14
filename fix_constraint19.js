const fs = require('fs');

let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');
file = file.replace(
    'ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n',
    ''
);
file = file.replace(
    'ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n',
    ''
);
file = file.replace(
    'ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "public"."agents" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n',
    ''
);

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
