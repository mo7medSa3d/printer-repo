-- First-class human identity metadata for manager sessions.
-- Legacy environment credentials remain a controlled bootstrap path and are
-- represented as owner sessions with a NULL user_id until migrated.
ALTER TABLE "manager_sessions" ADD COLUMN IF NOT EXISTS "user_id" text REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "manager_sessions" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'owner';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manager_sessions_role_check') THEN
    ALTER TABLE "manager_sessions" ADD CONSTRAINT "manager_sessions_role_check" CHECK (role IN ('owner','admin','operator','viewer','integration_admin','billing_admin'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manager_sessions_user_idx" ON "manager_sessions" USING btree ("user_id");
--> statement-breakpoint
UPDATE "manager_sessions" SET "role" = 'owner' WHERE "role" IS NULL OR "role" NOT IN ('owner','admin','operator','viewer','integration_admin','billing_admin');
