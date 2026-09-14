const fs = require('fs');
let file = fs.readFileSync('drizzle/0029_enforce_tenant_id_not_null.sql', 'utf8');
file = file.replace(
  'UPDATE print_jobs SET tenant_id = known_tenant WHERE tenant_id IS NULL;',
  'ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_payload_contract_check;\n    UPDATE print_jobs SET tenant_id = known_tenant WHERE tenant_id IS NULL;\n    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_payload_contract_check CHECK (\n      jsonb_typeof(payload) = \'object\' AND (\n        (payload->>\'type\' = \'raw\' AND COALESCE(payload->>\'protocol\', \'\') IN (\'raw\', \'escpos\', \'zpl\', \'tspl\'))\n        OR (payload->>\'type\' = \'escpos\' AND COALESCE(payload->>\'protocol\', \'\') = \'escpos\')\n        OR (payload->>\'type\' = \'pdf\' AND COALESCE(payload->>\'protocol\', \'\') = \'\')\n        OR (payload->>\'type\' = \'image\' AND COALESCE(payload->>\'protocol\', \'\') = \'\')\n      )\n    ) NOT VALID;'
);
file = file.replace(
    'UPDATE printers SET tenant_id = known_tenant WHERE tenant_id IS NULL;\n    UPDATE discovery_sessions SET tenant_id = known_tenant WHERE tenant_id IS NULL;',
    'UPDATE discovery_sessions SET tenant_id = known_tenant WHERE tenant_id IS NULL;\n    UPDATE printers SET tenant_id = known_tenant WHERE tenant_id IS NULL;'
);

fs.writeFileSync('drizzle/0029_enforce_tenant_id_not_null.sql', file);
