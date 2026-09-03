-- Repair migration 0012 for isolated schemas.
--
-- Migration 0012 checked pg_constraint by name globally. PostgreSQL allows the
-- same constraint name in different schemas, so a constraint in public could
-- incorrectly suppress creation in a worker schema. Keep 0012 immutable and
-- add the missing constraints in a corrective migration instead.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agents_status_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_status_check
      CHECK (status IN ('online', 'offline'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'printers_status_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE printers
      ADD CONSTRAINT printers_status_check
      CHECK (status IN ('online', 'offline', 'busy', 'error', 'unknown'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'printer_bindings_priority_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE printer_bindings
      ADD CONSTRAINT printer_bindings_priority_check
      CHECK (priority >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_status_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_status_check
      CHECK (status IN ('queued', 'claimed', 'printing', 'success', 'failed', 'expired'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_retries_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_retries_check
      CHECK (retries >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'print_jobs_delivery_attempts_check'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_delivery_attempts_check
      CHECK (delivery_attempts >= 0);
  END IF;
END $$;
