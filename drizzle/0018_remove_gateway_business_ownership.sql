-- Print Gateway is a runtime system. Odoo owns business/routing configuration.
-- The legacy business-ownership tables are intentionally removed rather than hidden.
DROP TABLE IF EXISTS printer_bindings CASCADE;
DROP TABLE IF EXISTS document_types CASCADE;
DROP TABLE IF EXISTS destinations CASCADE;
DROP TABLE IF EXISTS local_networks CASCADE;
DROP TABLE IF EXISTS discovered_devices CASCADE;
DROP TABLE IF EXISTS discovery_sessions CASCADE;
DROP TABLE IF EXISTS print_jobs CASCADE;
DROP TABLE IF EXISTS printers CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;

CREATE TABLE agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  pairing_code text,
  pairing_code_expires_at timestamptz,
  secret text,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','disabled','retired')),
  metadata jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_last_seen_idx ON agents(last_seen_at);

CREATE TABLE printers (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  name text NOT NULL,
  printer_type text NOT NULL DEFAULT 'physical' CHECK (printer_type IN ('physical','virtual','redirected')),
  device_class text NOT NULL DEFAULT 'unknown' CHECK (device_class IN ('thermal','laser','inkjet','label','other','unknown')),
  connection_type text NOT NULL DEFAULT 'network' CHECK (connection_type IN ('network','usb','spooler','ipp','ipps')),
  protocol text NOT NULL DEFAULT 'raw' CHECK (protocol IN ('raw','escpos','ipp','ipps','spooler')),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('online','offline','busy','error','unknown')),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','disabled','retired')),
  config jsonb,
  capabilities jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX printers_agent_id_idx ON printers(agent_id);
CREATE INDEX printers_status_idx ON printers(status);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  hashed_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE discovery_sessions (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL DEFAULT 'running',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discovery_sessions_agent_id_idx ON discovery_sessions(agent_id);
CREATE INDEX discovery_sessions_status_idx ON discovery_sessions(status);

CREATE TABLE discovered_devices (
  id text PRIMARY KEY,
  discovery_id text NOT NULL REFERENCES discovery_sessions(id),
  agent_id text NOT NULL REFERENCES agents(id),
  source text[] NOT NULL DEFAULT ARRAY[]::text[],
  protocol text NOT NULL DEFAULT 'unknown',
  ip_address text,
  hostname text,
  port integer,
  mac_address text,
  device_name text,
  manufacturer text,
  model text,
  serial_number text,
  firmware_version text,
  printer_state text,
  uri text,
  transport text,
  confidence text NOT NULL DEFAULT 'low',
  verification text NOT NULL DEFAULT 'candidate',
  device_class text NOT NULL DEFAULT 'unknown',
  capabilities jsonb,
  raw_metadata jsonb,
  provisioned_printer_id text REFERENCES printers(id),
  candidate_status text NOT NULL DEFAULT 'discovered',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discovered_devices_discovery_id_idx ON discovered_devices(discovery_id);
CREATE INDEX discovered_devices_agent_id_idx ON discovered_devices(agent_id);
CREATE INDEX discovered_devices_candidate_status_idx ON discovered_devices(candidate_status);

CREATE TABLE print_jobs (
  id text PRIMARY KEY,
  document_type text,
  destination text,
  agent_id text NOT NULL REFERENCES agents(id),
  printer_id text NOT NULL REFERENCES printers(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','printing','success','failed','expired')),
  payload jsonb NOT NULL,
  error text,
  requested_by text,
  idempotency_key text,
  retries integer NOT NULL DEFAULT 0 CHECK (retries >= 0),
  claimed_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at timestamptz,
  acked_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX print_jobs_agent_status_idx ON print_jobs(agent_id,status);
CREATE INDEX print_jobs_printer_status_idx ON print_jobs(printer_id,status);
CREATE INDEX print_jobs_status_expires_idx ON print_jobs(status,expires_at);
CREATE INDEX print_jobs_claimed_at_idx ON print_jobs(status,claimed_at);
CREATE UNIQUE INDEX print_jobs_idempotency_unique ON print_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
