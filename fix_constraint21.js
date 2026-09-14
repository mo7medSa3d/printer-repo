const fs = require('fs');

let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');
file = file.replace(
    'ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_provisioned_printer_id_fk" FOREIGN KEY ("tenant_id", "provisioned_printer_id") REFERENCES "public"."printers" ("tenant_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;\n',
    ''
);

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
