-- Enforce the runtime state machines at the database boundary as well as in
-- application code. This prevents bad states from being introduced by an
-- emergency SQL session, an old agent build, or an unpatched API path.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_status_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_status_check
      CHECK (status IN ('online', 'offline'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printers_status_check'
  ) THEN
    ALTER TABLE printers
      ADD CONSTRAINT printers_status_check
      CHECK (status IN ('online', 'offline', 'busy', 'error', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'printer_bindings_priority_check'
  ) THEN
    ALTER TABLE printer_bindings
      ADD CONSTRAINT printer_bindings_priority_check
      CHECK (priority >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_status_check'
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_status_check
      CHECK (status IN ('queued', 'claimed', 'printing', 'success', 'failed', 'expired'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_retries_check'
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_retries_check
      CHECK (retries >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'print_jobs_delivery_attempts_check'
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_delivery_attempts_check
      CHECK (delivery_attempts >= 0);
  END IF;
END $$;
