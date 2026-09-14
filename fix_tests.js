const fs = require('fs');

let idempTest = fs.readFileSync('tests/print-idempotency.test.ts', 'utf8');
idempTest = idempTest.replace(
  'VALUES ($1, $2, $3, \'physical\', \'other\', \'spooler\', \'spooler\', \'online\', \'active\', \'{}\'::jsonb, $4::jsonb)',
  'VALUES ($1, $2, $3, \'Second Printer\', \'physical\', \'other\', \'spooler\', \'spooler\', \'online\', \'active\', \'{}\'::jsonb, $4::jsonb)'
);
idempTest = idempTest.replace(
    '[secondPrinter, f.agentId, "Second Printer", JSON.stringify({ supported_protocols: ["pdf"] })],',
    '[secondPrinter, f.tenantId, f.agentId, JSON.stringify({ supported_protocols: ["pdf"] })],'
);
fs.writeFileSync('tests/print-idempotency.test.ts', idempTest);
