const fs = require('fs');

let file = fs.readFileSync('tests/auth-rate-limit.test.ts', 'utf8');
file = file.replace(
  'process.env.MANAGER_PASSWORD = PASS;',
  'process.env.MANAGER_PASSWORD = PASS;\n    process.env.MANAGER_TENANT_ID = "legacy_default";'
);

fs.writeFileSync('tests/auth-rate-limit.test.ts', file);
