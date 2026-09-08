ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pairing_code_hash" text;

UPDATE "agents"
SET "pairing_code_hash" = encode(sha256(upper(trim("pairing_code"))::bytea), 'hex')
WHERE "pairing_code" IS NOT NULL
  AND ("pairing_code_expires_at" IS NULL OR "pairing_code_expires_at" > NOW());

ALTER TABLE "agents" DROP COLUMN IF EXISTS "pairing_code";
