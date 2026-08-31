CREATE TABLE IF NOT EXISTS "branches" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text,
  "name" text NOT NULL,
  "description" text,
  "location" text,
  "timezone" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "gateway_url" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "destinations" (
  "id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "description" text,
  "zone" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "local_networks" (
  "id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "printer_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "destination_id" text NOT NULL,
  "document_type" text,
  "printer_id" text NOT NULL,
  "priority" integer DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "enabled_at" timestamp DEFAULT now() NOT NULL,
  "disabled_at" timestamp,
  "config_override" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "branch_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "local_network_id" text;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;

ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "branch_id" text;
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "printer_type" text DEFAULT 'thermal' NOT NULL;
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "connection_type" text DEFAULT 'tcp' NOT NULL;
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "protocol" text DEFAULT 'escpos' NOT NULL;
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;

ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "branch_id" text;
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "destination_id" text;
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "document_type" text;
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "requested_by" text;

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "branch_id" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'standard' NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "allowed_document_types" jsonb;

ALTER TABLE "printer_bindings" ADD COLUMN IF NOT EXISTS "document_type" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "branches") THEN
    INSERT INTO "branches" ("id", "name", "enabled") VALUES ('default', 'Default Branch', true);
  END IF;
END $$;

UPDATE "agents"
SET "branch_id" = 'default'
WHERE "branch_id" IS NULL;

UPDATE "printers"
SET "branch_id" = 'default'
WHERE "branch_id" IS NULL;

UPDATE "print_jobs"
SET "branch_id" = 'default'
WHERE "branch_id" IS NULL;

UPDATE "api_keys"
SET "branch_id" = 'default'
WHERE "branch_id" IS NULL AND "name" IS NOT NULL;

ALTER TABLE "agents" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "printers" ALTER COLUMN "branch_id" SET NOT NULL;
ALTER TABLE "print_jobs" ALTER COLUMN "branch_id" SET NOT NULL;

ALTER TABLE "agents" ADD CONSTRAINT IF NOT EXISTS "agents_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "agents" ADD CONSTRAINT IF NOT EXISTS "agents_local_network_id_local_networks_id_fk" FOREIGN KEY ("local_network_id") REFERENCES "public"."local_networks"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printers" ADD CONSTRAINT IF NOT EXISTS "printers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "print_jobs" ADD CONSTRAINT IF NOT EXISTS "print_jobs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "print_jobs" ADD CONSTRAINT IF NOT EXISTS "print_jobs_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "api_keys" ADD CONSTRAINT IF NOT EXISTS "api_keys_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "destinations" ADD CONSTRAINT IF NOT EXISTS "destinations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "local_networks" ADD CONSTRAINT IF NOT EXISTS "local_networks_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings" ADD CONSTRAINT IF NOT EXISTS "printer_bindings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings" ADD CONSTRAINT IF NOT EXISTS "printer_bindings_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "printer_bindings" ADD CONSTRAINT IF NOT EXISTS "printer_bindings_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "agents_branch_id_idx" ON "agents" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "agents_local_network_id_idx" ON "agents" USING btree ("local_network_id");
CREATE INDEX IF NOT EXISTS "printers_branch_id_idx" ON "printers" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "printers_printer_type_idx" ON "printers" USING btree ("printer_type");
CREATE INDEX IF NOT EXISTS "printers_status_idx" ON "printers" USING btree ("status");
CREATE INDEX IF NOT EXISTS "print_jobs_branch_id_idx" ON "print_jobs" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "print_jobs_destination_id_idx" ON "print_jobs" USING btree ("destination_id");
CREATE INDEX IF NOT EXISTS "api_keys_branch_id_idx" ON "api_keys" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "branches_name_idx" ON "branches" USING btree ("name");
CREATE INDEX IF NOT EXISTS "branches_enabled_idx" ON "branches" USING btree ("enabled");
CREATE INDEX IF NOT EXISTS "destinations_branch_id_idx" ON "destinations" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "destinations_type_idx" ON "destinations" USING btree ("type");
CREATE INDEX IF NOT EXISTS "destinations_enabled_idx" ON "destinations" USING btree ("enabled");
CREATE INDEX IF NOT EXISTS "local_networks_branch_id_idx" ON "local_networks" USING btree ("branch_id");
CREATE INDEX IF NOT EXISTS "printer_bindings_routing_idx" ON "printer_bindings" USING btree ("branch_id", "destination_id", "document_type", "priority");
CREATE INDEX IF NOT EXISTS "printer_bindings_printer_id_idx" ON "printer_bindings" USING btree ("printer_id");
CREATE INDEX IF NOT EXISTS "printer_bindings_enabled_idx" ON "printer_bindings" USING btree ("enabled");
