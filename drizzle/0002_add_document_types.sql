CREATE TABLE IF NOT EXISTS "document_types" (
  "id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "payload_hint" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_types_branch_id_branches_id_fk'
  ) THEN
    ALTER TABLE "document_types" ADD CONSTRAINT "document_types_branch_id_branches_id_fk"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_types_branch_id_idx" ON "document_types" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_types_name_idx" ON "document_types" USING btree ("name");
