-- SaaS control-plane foundations: durable audit trail, entitlements and deployment placement.
CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "request_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_actor_type_check" CHECK (actor_type IN ('user','odoo','agent','desktop','system','platform'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type", "actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type", "resource_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL UNIQUE,
  "entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_subscriptions" (
  "tenant_id" text PRIMARY KEY NOT NULL REFERENCES "tenants"("id"),
  "plan_id" text NOT NULL REFERENCES "plans"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "current_period_end" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_subscriptions_status_check" CHECK (status IN ('trialing','active','past_due','paused','cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployment_stamps" (
  "id" text PRIMARY KEY NOT NULL,
  "region" text NOT NULL,
  "tier" text NOT NULL DEFAULT 'shared',
  "capacity_class" text NOT NULL DEFAULT 'standard',
  "state" text NOT NULL DEFAULT 'active',
  "version" text NOT NULL,
  "health" text NOT NULL DEFAULT 'unknown',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "deployment_stamps_tier_check" CHECK (tier IN ('shared','bridge','dedicated')),
  CONSTRAINT "deployment_stamps_state_check" CHECK (state IN ('provisioning','active','draining','degraded','retired'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployment_stamps_region_state_idx" ON "deployment_stamps" USING btree ("region", "state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_deployment_assignments" (
  "tenant_id" text PRIMARY KEY NOT NULL REFERENCES "tenants"("id"),
  "deployment_id" text NOT NULL REFERENCES "deployment_stamps"("id"),
  "state" text NOT NULL DEFAULT 'active',
  "desired_version" text,
  "assigned_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_deployment_assignments_state_check" CHECK (state IN ('pending','active','draining','migrating','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_deployment_assignments_deployment_idx" ON "tenant_deployment_assignments" USING btree ("deployment_id");
