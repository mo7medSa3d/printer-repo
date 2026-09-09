-- Corrective migration for 0001 (schema drift, same class as 0025): the
-- printers table was created with `printer_type DEFAULT 'thermal'` and
-- `connection_type DEFAULT 'tcp'`, but 0006 added CHECK constraints that
-- admit only ('physical','virtual','redirected') / network-family values,
-- and 0006's own data backfill normalized every existing row to
-- printer_type='physical'. Any future INSERT that omits these columns
-- (raw SQL, a new ORM path, drizzle-kit push) would therefore fail with
-- CHECK 23514 — or, before 0025-era checks, silently insert a legacy value
-- no code recognizes. Align the DB defaults with the application contract
-- (src/db/schema.ts declares 'physical' / 'network'). Idempotent and
-- repeatable; changing a DEFAULT is metadata-only (no table rewrite, no
-- ACCESS EXCLUSIVE lock beyond the catalog row).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'printers'
  ) THEN
    ALTER TABLE printers ALTER COLUMN printer_type SET DEFAULT 'physical';
    ALTER TABLE printers ALTER COLUMN connection_type SET DEFAULT 'network';
  END IF;
END $$;
