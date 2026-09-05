CREATE TABLE IF NOT EXISTS print_job_rate_limits (
  api_key_id text PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  minute_window_started_at timestamp NOT NULL DEFAULT now(),
  minute_count integer NOT NULL DEFAULT 0,
  hour_window_started_at timestamp NOT NULL DEFAULT now(),
  hour_count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT print_job_rate_limits_minute_count_check CHECK (minute_count >= 0),
  CONSTRAINT print_job_rate_limits_hour_count_check CHECK (hour_count >= 0)
);

CREATE INDEX IF NOT EXISTS print_job_rate_limits_updated_idx
  ON print_job_rate_limits(updated_at);
