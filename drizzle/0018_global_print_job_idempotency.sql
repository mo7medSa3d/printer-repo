DO $$
BEGIN
  IF EXISTS (
    SELECT idempotency_key
    FROM print_jobs
    WHERE idempotency_key IS NOT NULL
    GROUP BY idempotency_key
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce global print-job idempotency: duplicate idempotency keys already exist';
  END IF;
END $$;

DROP INDEX IF EXISTS print_jobs_branch_idempotency_unique;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_idempotency_unique
  ON print_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
