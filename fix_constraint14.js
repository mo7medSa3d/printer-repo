const fs = require('fs');
let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

file = file.replace(
    'ALTER TABLE "discovered_devices"\n  ADD CONSTRAINT "discovered_devices_tenant_id_discovery_id_fk"\n  FOREIGN KEY ("tenant_id", "discovery_id")\n  REFERENCES "public"."discovery_sessions" ("tenant_id", "id")\n  ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);

file = file.replace(
    'ALTER TABLE "discovered_devices"\n  ADD CONSTRAINT "discovered_devices_tenant_id_agent_id_agents_fk"\n  FOREIGN KEY ("tenant_id", "agent_id")\n  REFERENCES "public"."agents" ("tenant_id", "id")\n  ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);

file = file.replace(
    'ALTER TABLE "discovered_devices"\n  ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_printers_fk"\n  FOREIGN KEY ("tenant_id", "provisioned_printer_id")\n  REFERENCES "public"."printers" ("tenant_id", "id")\n  ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
