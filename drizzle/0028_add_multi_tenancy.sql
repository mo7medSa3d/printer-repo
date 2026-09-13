CREATE TABLE IF NOT EXISTS "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"type" text DEFAULT 'odoo' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"locked_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovered_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"discovery_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"source" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"protocol" text DEFAULT 'unknown' NOT NULL,
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
	"confidence" text DEFAULT 'low' NOT NULL,
	"verification" text DEFAULT 'candidate' NOT NULL,
	"device_class" text DEFAULT 'unknown' NOT NULL,
	"capabilities" jsonb,
	"raw_metadata" jsonb,
	"provisioned_printer_id" text,
	"candidate_status" text DEFAULT 'discovered' NOT NULL,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovered_devices_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_sessions_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "discovery_sessions" ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
ALTER TABLE "discovered_devices" ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sessions_tenant_id_unique'
  ) THEN
    ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_tenant_id_unique'
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "gateway_metrics" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_metrics_value_check" CHECK ("gateway_metrics"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_job_rate_limits" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"minute_window_started_at" timestamp NOT NULL,
	"minute_count" integer DEFAULT 0 NOT NULL,
	"hour_window_started_at" timestamp NOT NULL,
	"hour_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_users" (
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "print_jobs" DROP CONSTRAINT IF EXISTS "print_jobs_printer_id_printers_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pairing_code_hash" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "allowed_document_types" jsonb;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "api_key_id" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "destination" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "document_type" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "requested_by" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "claim_token" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "acked_at" timestamp;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "printer_type" text DEFAULT 'physical' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "device_class" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "connection_type" text DEFAULT 'network' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "protocol" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_discovery_id_discovery_sessions_id_fk'
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_discovery_id_discovery_sessions_id_fk" FOREIGN KEY ("discovery_id") REFERENCES "public"."discovery_sessions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_provisioned_printer_id_printers_id_fk'
  ) THEN
    ALTER TABLE "discovered_devices" ADD CONSTRAINT "discovered_devices_provisioned_printer_id_printers_id_fk" FOREIGN KEY ("provisioned_printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sessions_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovery_sessions_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "discovery_sessions" ADD CONSTRAINT "discovery_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_job_rate_limits_api_key_id_api_keys_id_fk'
  ) THEN
    ALTER TABLE "print_job_rate_limits" ADD CONSTRAINT "print_job_rate_limits_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_users_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_users_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_rate_limits_locked_until_idx" ON "auth_rate_limits" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_rate_limits_updated_at_idx" ON "auth_rate_limits" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_devices_discovery_id_idx" ON "discovered_devices" USING btree ("discovery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_devices_agent_id_idx" ON "discovered_devices" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_devices_candidate_status_idx" ON "discovered_devices" USING btree ("candidate_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovered_devices_confidence_idx" ON "discovered_devices" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_sessions_agent_id_idx" ON "discovery_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_sessions_status_idx" ON "discovery_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_users_pk" ON "tenant_users" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_users_tenant_idx" ON "tenant_users" USING btree ("tenant_id");--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_api_key_id_api_keys_id_fk'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_tenant_id_unique'
  ) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tenant_id_unique'
  ) THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_unique'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_tenant_id_unique'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_unique" UNIQUE("tenant_id","id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_agent_id_agents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."agents"("tenant_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_printer_id_printers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","printer_id") REFERENCES "public"."printers"("tenant_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_tenant_id_tenants_id_fk'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_tenant_status_idx" ON "print_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_claimed_at_idx" ON "print_jobs" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_api_key_id_idx" ON "print_jobs" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_idempotency_unique" ON "print_jobs" USING btree ("api_key_id","idempotency_key") WHERE idempotency_key IS NOT NULL AND api_key_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "print_jobs_internal_idempotency_unique" ON "print_jobs" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL AND api_key_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "printers_printer_type_idx" ON "printers" USING btree ("printer_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "printers_status_idx" ON "printers" USING btree ("status");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "pairing_code";--> statement-breakpoint
ALTER TABLE "printers" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
ALTER TABLE "printers" DROP COLUMN IF EXISTS "enabled";--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_lifecycle_check'
  ) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_lifecycle_check" CHECK ("agents"."lifecycle" in ('active','disabled','retired'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_status_check'
  ) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('online','offline'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_status_check'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_status_check" CHECK ("print_jobs"."status" in ('queued','claimed','printing','success','failed','expired'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_retries_check'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_retries_check" CHECK ("print_jobs"."retries" >= 0);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_delivery_attempts_check'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_delivery_attempts_check" CHECK ("print_jobs"."delivery_attempts" >= 0);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_payload_contract_check'
  ) THEN
    ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_payload_contract_check" CHECK (jsonb_typeof("print_jobs"."payload") = 'object' AND (
    ("print_jobs"."payload"->>'type' = 'raw' AND COALESCE("print_jobs"."payload"->>'protocol', '') in ('raw','escpos','zpl','tspl'))
    OR ("print_jobs"."payload"->>'type' = 'escpos' AND COALESCE("print_jobs"."payload"->>'protocol', '') = 'escpos')
    OR ("print_jobs"."payload"->>'type' = 'pdf' AND COALESCE("print_jobs"."payload"->>'protocol', '') = '')
    OR ("print_jobs"."payload"->>'type' = 'image' AND COALESCE("print_jobs"."payload"->>'protocol', '') = '')
  ));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_lifecycle_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_lifecycle_check" CHECK ("printers"."lifecycle" in ('active','disabled','retired'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_type_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_type_check" CHECK ("printers"."printer_type" in ('physical','virtual','redirected'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_device_class_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_device_class_check" CHECK ("printers"."device_class" in ('thermal','laser','inkjet','label','other','unknown'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_connection_type_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_connection_type_check" CHECK ("printers"."connection_type" in ('network','usb','spooler','ipp','ipps'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_protocol_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_protocol_check" CHECK ("printers"."protocol" in ('raw','escpos','zpl','tspl','ipp','ipps','spooler','windows_spooler','unknown'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_status_check'
  ) THEN
    ALTER TABLE "printers" ADD CONSTRAINT "printers_status_check" CHECK ("printers"."status" in ('online','offline','busy','error','unknown'));
  END IF;
END $$;
