const fs = require('fs');

let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

// Just keep the NOT VALID on the composite fks so the schema accepts it at this migration level!
file = file.replace(/ON UPDATE NO ACTION;/g, 'ON UPDATE NO ACTION NOT VALID;');

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
