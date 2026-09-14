const fs = require('fs');

let file = fs.readFileSync('tests/multi-instance-gateway.test.ts', 'utf8');

file = file.replace(
  'process.env.MANAGER_TENANT_ID = "legacy_default";',
  'process.env.MANAGER_TENANT_ID = "tenant_upgrade_fixture";'
);
file = file.replace(
  'await pool().query(`INSERT INTO tenants (id, name) VALUES (\\\'legacy_default\\\', \\\'Legacy installation\\\') ON CONFLICT DO NOTHING`);',
  'await pool().query(`INSERT INTO tenants (id, name) VALUES (\\\'tenant_upgrade_fixture\\\', \\\'Test installation\\\') ON CONFLICT DO NOTHING`);'
)
fs.writeFileSync('tests/multi-instance-gateway.test.ts', file);
