const fs = require('fs');
let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

file = file.replace(
    'ALTER TABLE "printers"\n  ADD CONSTRAINT "printers_tenant_id_agent_id_agents_fk"\n  FOREIGN KEY ("tenant_id", "agent_id")\n  REFERENCES "public"."agents" ("tenant_id", "id")\n  ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
