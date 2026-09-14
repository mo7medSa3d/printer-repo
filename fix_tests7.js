const fs = require('fs');

let file = fs.readFileSync('tests/auth-rate-limit.test.ts', 'utf8');

file = file.replace(
  'process.env.MANAGER_TENANT_ID = "tenant_upgrade_fixture";',
  'process.env.MANAGER_TENANT_ID = "legacy_default";'
);
file = file.replace(
  'await pool().query(`INSERT INTO tenants (id, name) VALUES (\\\'tenant_upgrade_fixture\\\', \\\'Test installation\\\') ON CONFLICT DO NOTHING`);',
  'await pool().query(`INSERT INTO tenants (id, name) VALUES (\\\'legacy_default\\\', \\\'Legacy installation\\\') ON CONFLICT DO NOTHING`);'
)
fs.writeFileSync('tests/auth-rate-limit.test.ts', file);
