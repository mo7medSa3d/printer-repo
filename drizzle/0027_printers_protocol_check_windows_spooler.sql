-- Reconcile printers_protocol_check to include 'windows_spooler'
-- and discovered_devices_protocol_check to include 'zpl'/'tspl'.
--
-- The agent legitimately reports Windows spooler queues with
-- protocol='windows_spooler' (see agent/internal/printer/registry.go and
-- the discovery source list). Without this value in the CHECK, heartbeat
-- upserts for such printers fail with 23514 and the printers can never
-- sync. Likewise, SNMP discovery identifies Zebra/TSC barcode printers as
-- zpl/tspl; without those values the whole discovery session aborts on
-- 23514 when persisting candidates.
--
-- This migration changes nothing else: timestamp columns stay
-- `timestamp without time zone` (the application runs TZ=UTC everywhere
-- by deployment contract) and the idempotency indexes from
-- 0021/0023 stay exactly as declared in src/db/schema.ts.
-- NOTE: src/db/schema.ts never declared the discovered_devices protocol
-- CHECK (0025 added it via raw SQL), so no schema.ts change is needed;
-- this follows the 0025 precedent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'printers'
  ) THEN
    ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_protocol_check;
    ALTER TABLE printers
      ADD CONSTRAINT printers_protocol_check
      CHECK (protocol IN ('raw', 'escpos', 'zpl', 'tspl', 'ipp', 'ipps', 'spooler', 'windows_spooler', 'unknown'));
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'discovered_devices'
  ) THEN
    ALTER TABLE discovered_devices DROP CONSTRAINT IF EXISTS discovered_devices_protocol_check;
    ALTER TABLE discovered_devices
      ADD CONSTRAINT discovered_devices_protocol_check
      CHECK (protocol IN ('ipp', 'ipps', 'raw', 'lpr', 'mdns', 'snmp', 'wsd', 'windows_spooler', 'usb', 'unknown', 'escpos', 'spooler', 'zpl', 'tspl'));
  END IF;
END $$;
