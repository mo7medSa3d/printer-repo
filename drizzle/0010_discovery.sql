-- Discovery sessions and candidates: transient runtime records with TTL, not historical printer identity.
-- Ownership via Agent -> Branch, never Branch -> Printer directly.

CREATE TABLE IF NOT EXISTS "discovery_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "branch_id" text NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed','cancelled')),
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "discovery_sessions_agent_id_idx" ON "discovery_sessions" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "discovery_sessions_branch_id_idx" ON "discovery_sessions" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "discovery_sessions_status_idx" ON "discovery_sessions" USING btree ("status");

CREATE TABLE IF NOT EXISTS "discovered_devices" (
  "id" text PRIMARY KEY NOT NULL,
  "discovery_id" text NOT NULL REFERENCES "discovery_sessions"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "branch_id" text NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "source" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "protocol" text NOT NULL DEFAULT 'unknown' CHECK (protocol IN ('ipp','ipps','raw','lpr','mdns','snmp','wsd','windows_spooler','usb','unknown','escpos','spooler')),
  "ip_address" text,
  "hostname" text,
  "port" integer,
  "mac_address" text,
  "device_name" text,
  "manufacturer" text,
  "model" text,
  "serial_number" text,
  "firmware_version" text,
  "printer_state" text,
  "uri" text,
  "transport" text,
  "confidence" text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low','medium','high')),
  "verification" text NOT NULL DEFAULT 'candidate' CHECK (verification IN ('candidate','verified')),
  "device_class" text DEFAULT 'unknown',
  "capabilities" jsonb,
  "raw_metadata" jsonb,
  "provisioned_printer_id" text REFERENCES "printers"("id") ON DELETE SET NULL,
  "candidate_status" text NOT NULL DEFAULT 'discovered' CHECK (candidate_status IN ('discovered','verified','provisioned','ignored','expired')),
  "discovered_at" timestamp DEFAULT now() NOT NULL,
  "last_seen_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "discovered_devices_discovery_id_idx" ON "discovered_devices" USING btree ("discovery_id");
CREATE INDEX IF NOT EXISTS "discovered_devices_agent_id_idx" ON "discovered_devices" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "discovered_devices_branch_id_idx" ON "discovered_devices" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "discovered_devices_candidate_status_idx" ON "discovered_devices" USING btree ("candidate_status");
CREATE INDEX IF NOT EXISTS "discovered_devices_confidence_idx" ON "discovered_devices" USING btree ("confidence");
CREATE UNIQUE INDEX IF NOT EXISTS "discovered_devices_agent_identity_unique" ON "discovered_devices" USING btree ("agent_id", "ip_address", "port", "protocol") WHERE "ip_address" IS NOT NULL;
