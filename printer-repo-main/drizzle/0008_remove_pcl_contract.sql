-- PCL is intentionally NOT supported end-to-end.
-- Never rewrite existing configuration automatically: ambiguous/unsupported
-- rows block deployment and must be remediated explicitly before upgrade.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_types WHERE lower(coalesce(payload_hint,'')) = 'pcl') THEN
    RAISE EXCEPTION 'Migration blocked: document_types contain payload_hint=pcl. Remediate these records explicitly (raw/escpos/pdf) before deployment.';
  END IF;
  IF EXISTS (SELECT 1 FROM printers WHERE lower(protocol) = 'pcl') THEN
    RAISE EXCEPTION 'Migration blocked: printers contain protocol=pcl. Remediate these records explicitly before deployment.';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_types_payload_hint_check') THEN
    ALTER TABLE document_types ADD CONSTRAINT document_types_payload_hint_check
      CHECK (payload_hint IS NULL OR payload_hint IN ('raw','escpos','pdf'));
  END IF;
END $$;
