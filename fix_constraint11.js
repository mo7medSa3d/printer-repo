const fs = require('fs');
let file = fs.readFileSync('drizzle/0028_add_multi_tenancy.sql', 'utf8');

file = file.replace(
    'ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;',
    'ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action NOT VALID;'
);
file = file.replace(
    'ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;',
    'ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action NOT VALID;'
);

fs.writeFileSync('drizzle/0028_add_multi_tenancy.sql', file);
