CREATE TABLE IF NOT EXISTS gateway_metrics (
  name text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION notify_agent_job_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'print_gateway_agent_jobs',
    json_build_object('jobId', NEW.id, 'agentId', NEW.agent_id)::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS print_jobs_notify_agent_job_available ON print_jobs;
CREATE TRIGGER print_jobs_notify_agent_job_available
AFTER INSERT ON print_jobs
FOR EACH ROW
EXECUTE FUNCTION notify_agent_job_available();
