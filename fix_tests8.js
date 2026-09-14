const fs = require('fs');

let file = fs.readFileSync('package.json', 'utf8');

file = file.replace(
  '--exclude tests/tenant-isolation.test.ts',
  ''
);

fs.writeFileSync('package.json', file);
