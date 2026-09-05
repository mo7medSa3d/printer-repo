-- Keep discovery trust-state values constrained at the database boundary.
-- The gateway still controls which transitions are allowed by API policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_confidence_check'
  ) THEN
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_confidence_check
      CHECK (confidence IN ('low', 'medium', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_verification_check'
  ) THEN
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_verification_check
      CHECK (verification IN ('candidate', 'verified'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discovered_devices_candidate_status_check'
  ) THEN
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_candidate_status_check
      CHECK (candidate_status IN ('discovered', 'verified', 'provisioned', 'ignored', 'expired'));
  END IF;
END $$;
