const fs = require('fs');

// We have an issue where constraints with "NOT VALID" do not actively reject INSERTS until they are validated.
// We should remove NOT VALID so they are enforced immediately, which is required for the integration tests to work.

let file = fs.readFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', 'utf8');

file = file.replace(/NOT VALID;/g, ';');

fs.writeFileSync('drizzle/0031_enforce_tenant_cross_table_foreign_keys.sql', file);
