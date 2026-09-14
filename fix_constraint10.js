const fs = require('fs');
let file = fs.readFileSync('drizzle/0029_enforce_tenant_id_not_null.sql', 'utf8');

file = file.replace(
    'UPDATE printers SET tenant_id = known_tenant WHERE tenant_id IS NULL;',
    'ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_tenant_id_agent_id_agents_tenant_id_id_fk;\n    UPDATE printers SET tenant_id = known_tenant WHERE tenant_id IS NULL;\n    ALTER TABLE printers ADD CONSTRAINT printers_tenant_id_agent_id_agents_tenant_id_id_fk FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) NOT VALID;'
);

file = file.replace(
    'UPDATE print_jobs SET tenant_id = known_tenant WHERE tenant_id IS NULL;',
    'ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk;\n    ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk;\n    UPDATE print_jobs SET tenant_id = known_tenant WHERE tenant_id IS NULL;\n    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk FOREIGN KEY (tenant_id, printer_id) REFERENCES printers(tenant_id, id) NOT VALID;\n    ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) NOT VALID;'
)
fs.writeFileSync('drizzle/0029_enforce_tenant_id_not_null.sql', file);
