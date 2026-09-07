ALTER TABLE "print_jobs"
  DROP CONSTRAINT IF EXISTS "print_jobs_destination_id_destinations_id_fk";

COMMENT ON COLUMN "print_jobs"."destination_id" IS
  'Gateway destination label supplied by the Odoo integration boundary; retained column name for migration compatibility.';
