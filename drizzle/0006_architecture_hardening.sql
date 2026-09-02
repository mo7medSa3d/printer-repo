-- Production architecture hardening.
-- Fail-loud migration from legacy Gateway printer ownership/enablement fields.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'active';
ALTER TABLE printers ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'active';
ALTER TABLE printers ADD COLUMN IF NOT EXISTS device_class text NOT NULL DEFAULT 'unknown';

DO $$
DECLARE
  has_branch boolean;
  has_enabled boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='branch_id') INTO has_branch;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='enabled') INTO has_enabled;

  -- Only validate legacy ownership while that legacy field exists.
  IF has_branch THEN
    IF EXISTS (SELECT 1 FROM printers p LEFT JOIN agents a ON a.id = p.agent_id WHERE a.id IS NULL OR a.branch_id IS NULL) THEN
      RAISE EXCEPTION 'Migration blocked: orphaned printer or agent without branch exists. Repair ownership before continuing.';
    END IF;
    IF EXISTS (SELECT 1 FROM printers p JOIN agents a ON a.id = p.agent_id WHERE p.branch_id IS DISTINCT FROM a.branch_id) THEN
      RAISE EXCEPTION 'Migration blocked: printer/agent branch mismatch exists. Reassign/repair the printer to its owning agent before continuing.';
    END IF;
    IF EXISTS (SELECT 1 FROM printer_bindings b JOIN printers p ON p.id = b.printer_id JOIN agents a ON a.id = p.agent_id WHERE b.branch_id IS DISTINCT FROM a.branch_id) THEN
      RAISE EXCEPTION 'Migration blocked: cross-branch printer binding exists.';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM agents GROUP BY id HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Migration blocked: duplicate gateway agent IDs exist.';
  END IF;
  IF EXISTS (SELECT 1 FROM printers GROUP BY id HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Migration blocked: duplicate gateway printer IDs exist.';
  END IF;

  IF has_enabled THEN
    EXECUTE $mig$UPDATE printers SET lifecycle = CASE WHEN enabled = false THEN 'disabled' ELSE 'active' END WHERE enabled IS NOT NULL$mig$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_lifecycle_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_lifecycle_check CHECK (lifecycle IN ('active','disabled','retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_lifecycle_check') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_lifecycle_check CHECK (lifecycle IN ('active','disabled','retired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agents_lifecycle_idx ON agents(lifecycle);
CREATE INDEX IF NOT EXISTS printers_lifecycle_idx ON printers(lifecycle);

UPDATE printers SET config = CASE WHEN config IS NULL THEN NULL ELSE config - 'protocol' END;

-- Legacy printer_type values (thermal/laser/...) were device classes.
-- Normalize them into device_class and make printer_type describe entity kind.
UPDATE printers SET
  device_class = CASE WHEN lower(printer_type) IN ('thermal','laser','inkjet','label','other') THEN lower(printer_type) ELSE device_class END,
  printer_type = CASE WHEN lower(printer_type) IN ('virtual','redirected') THEN lower(printer_type) ELSE 'physical' END;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_type_check') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_type_check CHECK (printer_type IN ('physical','virtual','redirected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_device_class_check') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_device_class_check CHECK (device_class IN ('thermal','laser','inkjet','label','other','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_connection_type_check') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_connection_type_check CHECK (connection_type IN ('network','usb','spooler','ipp','ipps'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'printers_protocol_check') THEN
    ALTER TABLE printers ADD CONSTRAINT printers_protocol_check CHECK (protocol IN ('raw','escpos','ipp','ipps','spooler'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='branch_id') THEN
    ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_branch_id_branches_id_fk;
    DROP INDEX IF EXISTS printers_branch_id_idx;
    ALTER TABLE printers DROP COLUMN branch_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='type') THEN
    ALTER TABLE printers DROP COLUMN type;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='enabled') THEN
    ALTER TABLE printers DROP COLUMN enabled;
  END IF;
END $$;

-- IDs are gateway-global; these explicit indexes make the invariant visible.
CREATE UNIQUE INDEX IF NOT EXISTS agents_gateway_id_global_unique ON agents(id);
CREATE UNIQUE INDEX IF NOT EXISTS printers_gateway_id_global_unique ON printers(id);
