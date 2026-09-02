ALTER TABLE auth_rate_limits ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT NOW();
-- Bound authentication rate-limit state to a finite retention window.
CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_at_idx ON auth_rate_limits(updated_at);
DELETE FROM auth_rate_limits WHERE updated_at < NOW() - INTERVAL '24 hours';
