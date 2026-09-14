const fs = require('fs');
let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

file = file.replace(
    'ALTER TABLE "print_jobs"\n  ADD CONSTRAINT "print_jobs_tenant_id_api_key_id_api_keys_fk"\n  FOREIGN KEY ("tenant_id", "api_key_id")\n  REFERENCES "public"."api_keys" ("tenant_id", "id")\n  ON DELETE NO ACTION ON UPDATE NO ACTION;\n',
    ''
);

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
