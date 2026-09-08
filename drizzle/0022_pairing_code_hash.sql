ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pairing_code_hash" text;
ALTER TABLE "agents" DROP COLUMN IF EXISTS "pairing_code";
