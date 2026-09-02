-- Final invariant guard for installations that already executed earlier migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM printers WHERE agent_id IS NULL) THEN
    RAISE EXCEPTION 'Invariant violation: printer without agent_id exists; Gateway printer ownership is Agent-derived.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM printer_bindings b
    JOIN printers p ON p.id = b.printer_id
    JOIN agents a ON a.id = p.agent_id
    WHERE b.branch_id IS DISTINCT FROM a.branch_id
  ) THEN
    RAISE EXCEPTION 'Invariant violation: cross-branch printer binding exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM printers WHERE lower(protocol) = 'pcl') THEN
    RAISE EXCEPTION 'Invariant violation: unsupported PCL printer protocol exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM document_types WHERE lower(coalesce(payload_hint,'')) = 'pcl') THEN
    RAISE EXCEPTION 'Invariant violation: unsupported PCL payload hint exists.';
  END IF;
END $$;
