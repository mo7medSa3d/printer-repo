-- Domains are authorization mappings, not credentials. Only verified rows are accepted by manager login.
CREATE TABLE IF NOT EXISTS "tenant_domains" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "domain" text NOT NULL UNIQUE,
  "verified_at" timestamp,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_domains_tenant_idx" ON "tenant_domains" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_domains_verified_idx" ON "tenant_domains" USING btree ("verified_at");
--> statement-breakpoint
ALTER TABLE "manager_sessions" ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
ALTER TABLE "manager_sessions" ADD CONSTRAINT "manager_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
-- Existing manager sessions are ephemeral authentication state. Revoke them during migration
-- instead of guessing tenant ownership; users must sign in again.
DELETE FROM "manager_sessions";
--> statement-breakpoint
ALTER TABLE "manager_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manager_sessions_tenant_idx" ON "manager_sessions" USING btree ("tenant_id");
