-- Corrective migration for 0006/0014 (same bug class documented by 0013):
-- both guarded constraint creation with a GLOBAL pg_constraint name lookup,
-- which suppresses creation inside isolated worker schemas whenever a
-- same-named constraint already exists in another schema. Re-create the
-- missing printer-protocol and discovery trust-state constraints using the
-- namespace-joined guard (and, for 0014's trio, the equivalent
-- DROP/ADD-recreate guard so an existing globally-named constraint can never
-- suppress creation in this schema). Idempotent and repeatable.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'printers'
  ) THEN
    ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_protocol_check;
    ALTER TABLE printers
      ADD CONSTRAINT printers_protocol_check
      CHECK (protocol IN ('raw', 'escpos', 'zpl', 'tspl', 'ipp', 'ipps', 'spooler', 'unknown'));
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'discovered_devices'
  ) THEN
    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_confidence_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_confidence_check
      CHECK (confidence IN ('low', 'medium', 'high'));

    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_verification_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_verification_check
      CHECK (verification IN ('candidate', 'verified'));

    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_candidate_status_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_candidate_status_check
      CHECK (candidate_status IN ('discovered', 'verified', 'provisioned', 'ignored', 'expired'));

    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_protocol_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_protocol_check
      CHECK (protocol IN ('ipp', 'ipps', 'raw', 'lpr', 'mdns', 'snmp', 'wsd', 'windows_spooler', 'usb', 'unknown', 'escpos', 'spooler'));
  END IF;

  -- 'raw' as a silent column default is an implicit protocol inference. Every
  -- insert path states the protocol explicitly; an omitted protocol must
  -- surface as 'unknown' (which the capability model never routes to), not
  -- as a routable raw byte sink.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'printers'
  ) THEN
    ALTER TABLE printers ALTER COLUMN protocol SET DEFAULT 'unknown';
  END IF;
END $$;
