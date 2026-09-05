CREATE OR REPLACE FUNCTION notify_agent_job_available()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'queued' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM pg_notify(
      'print_gateway_agent_jobs',
      json_build_object('jobId', NEW.id, 'agentId', NEW.agent_id)::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS print_jobs_notify_agent_job_available ON print_jobs;
CREATE TRIGGER print_jobs_notify_agent_job_available
AFTER INSERT OR UPDATE OF status ON print_jobs
FOR EACH ROW
EXECUTE FUNCTION notify_agent_job_available();
