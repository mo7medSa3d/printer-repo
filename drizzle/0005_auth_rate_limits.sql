-- Database-backed auth rate limiter (shared across gateway instances).
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "key" text PRIMARY KEY,
  "failures" integer NOT NULL DEFAULT 0,
  "window_started_at" timestamp NOT NULL DEFAULT now(),
  "locked_until" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "auth_rate_limits_locked_until_idx" ON "auth_rate_limits" ("locked_until");
