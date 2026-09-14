const fs = require('fs');
let file = fs.readFileSync('tests/auth-rate-limit.test.ts', 'utf8');

file = file.replace(
    'await truncateAll();',
    'await truncateAll();\n    await pool().query(`INSERT INTO tenants (id, name) VALUES (\\\'legacy_default\\\', \\\'Legacy installation\\\') ON CONFLICT DO NOTHING`);'
);

fs.writeFileSync('tests/auth-rate-limit.test.ts', file);
