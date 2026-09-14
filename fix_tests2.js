const fs = require('fs');

let file = fs.readFileSync('tests/heartbeat-enabled.test.ts', 'utf8');
file = file.replace(
  'expect(body.skippedPrinters).toContain(other.printerId);',
  'expect(body.skippedPrinters.some(s => s.id === other.printerId)).toBe(true);'
);

fs.writeFileSync('tests/heartbeat-enabled.test.ts', file);
