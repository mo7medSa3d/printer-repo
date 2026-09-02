from odoo import api, SUPERUSER_ID


def migrate(cr, version):
    """Single canonical Odoo migration entrypoint for 1.1.0.

    Order is fail-safe:
      1. Validate existing data / detect incompatible state
      2. Fail loudly with remediation for ambiguous PCL / RAW data
      3. Backfill deterministic data
      4. Add new constraints
      5. Only then remove obsolete columns
    """
    if not version:
        return

    # ------------------------------------------------------------------ 1. PCL guard
    # Must run before any data mutation. No automatic rewrite is performed.
    cr.execute("SELECT id FROM print_gateway_document_type WHERE lower(payload_hint) = 'pcl' LIMIT 20")
    pcl_docs = [row[0] for row in cr.fetchall()]
    if pcl_docs:
        raise RuntimeError(
            "Migration blocked: PCL document types exist (ids=%s). "
            "Explicitly reconfigure them as raw, escpos, or pdf before upgrade." % pcl_docs
        )
    cr.execute("SELECT id FROM print_gateway_printer WHERE lower(protocol) = 'pcl' LIMIT 20")
    pcl_printers = [row[0] for row in cr.fetchall()]
    if pcl_printers:
        raise RuntimeError(
            "Migration blocked: PCL printer protocols exist (ids=%s). "
            "Explicitly reconfigure them before upgrade." % pcl_printers
        )

    # ------------------------------------------------------------------ 2. RAW guard
    # Former code blanket-reset raw->pdf. That silently reinterprets production
    # intent. If raw mappings exist, the operator must explicitly remap them.
    cr.execute("SELECT id FROM print_gateway_report_mapping WHERE payload_type = 'raw' LIMIT 20")
    raw_rows = [row[0] for row in cr.fetchall()]
    if raw_rows:
        raise RuntimeError(
            "Migration blocked: report mappings with payload_type='raw' exist (ids=%s). "
            "Reconfigure each mapping explicitly as 'pdf' or 'escpos' before upgrade; "
            "automatic raw->pdf conversion is not performed." % raw_rows
        )

    # ------------------------------------------------------------------ 3. Validate legacy relationships
    cr.execute("""
        SELECT p.gateway_printer_id, p.branch_id, p.gateway_agent_id, a.branch_id
          FROM print_gateway_printer p
          LEFT JOIN print_gateway_agent a ON a.gateway_agent_id = p.gateway_agent_id
         WHERE p.gateway_agent_id IS NULL OR a.id IS NULL OR p.branch_id IS DISTINCT FROM a.branch_id
         LIMIT 50
    """)
    rows = cr.fetchall()
    if rows:
        raise RuntimeError(
            "Migration blocked: printer ownership/branch data is inconsistent. "
            "Repair/reassign the affected printers to their authoritative agents before upgrading. "
            "Sample rows: %r" % (rows,)
        )

    cr.execute("""
        SELECT gateway_agent_id FROM print_gateway_agent
         WHERE gateway_agent_id IS NOT NULL
         GROUP BY gateway_agent_id HAVING COUNT(*) > 1
         LIMIT 50
    """)
    duplicates = cr.fetchall()
    if duplicates:
        raise RuntimeError("Migration blocked: duplicate gateway agent IDs exist: %r" % (duplicates,))

    cr.execute("""
        SELECT gateway_printer_id FROM print_gateway_printer
         WHERE gateway_printer_id IS NOT NULL
         GROUP BY gateway_printer_id HAVING COUNT(*) > 1
         LIMIT 50
    """)
    duplicates = cr.fetchall()
    if duplicates:
        raise RuntimeError("Migration blocked: duplicate gateway printer IDs exist: %r" % (duplicates,))

    cr.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS print_gateway_agent_gateway_id_unique
        ON print_gateway_agent (gateway_agent_id)
    """)
    cr.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS print_gateway_printer_gateway_id_unique
        ON print_gateway_printer (gateway_printer_id)
    """)

    # ------------------------------------------------------------------ 4. Backfill canonical Agent relation
    cr.execute("ALTER TABLE print_gateway_printer ADD COLUMN IF NOT EXISTS agent_id integer")
    cr.execute("ALTER TABLE print_gateway_printer ADD COLUMN IF NOT EXISTS device_class varchar")
    cr.execute("""
        UPDATE print_gateway_printer p
           SET agent_id = a.id
          FROM print_gateway_agent a
         WHERE a.gateway_agent_id = p.gateway_agent_id AND p.agent_id IS NULL
    """)
    cr.execute("""
        SELECT p.gateway_printer_id
          FROM print_gateway_printer p
         WHERE p.agent_id IS NULL
         LIMIT 50
    """)
    missing = cr.fetchall()
    if missing:
        raise RuntimeError("Migration blocked: printers without an owning agent remain: %r" % (missing,))

    # Add lifecycle from legacy enabled fields before the ORM field removal.
    cr.execute("ALTER TABLE print_gateway_agent ADD COLUMN IF NOT EXISTS lifecycle varchar")
    cr.execute("UPDATE print_gateway_agent SET lifecycle = 'active' WHERE lifecycle IS NULL")
    cr.execute("ALTER TABLE print_gateway_printer ADD COLUMN IF NOT EXISTS lifecycle varchar")
    cr.execute("UPDATE print_gateway_printer SET lifecycle = CASE WHEN enabled = FALSE THEN 'disabled' ELSE 'active' END WHERE lifecycle IS NULL")

    cr.execute("UPDATE print_gateway_printer SET device_class = CASE WHEN lower(printer_type) IN ('thermal','laser','inkjet','label','other') THEN lower(printer_type) ELSE 'unknown' END WHERE device_class IS NULL")
    cr.execute("UPDATE print_gateway_printer SET printer_type = CASE WHEN lower(printer_type) IN ('virtual','redirected') THEN lower(printer_type) ELSE 'physical' END")

    # ------------------------------------------------------------------ 5. Remove obsolete columns only after success
    cr.execute("ALTER TABLE print_gateway_printer DROP COLUMN IF EXISTS gateway_agent_id")
    cr.execute("ALTER TABLE print_gateway_printer DROP COLUMN IF EXISTS enabled")
    cr.execute("ALTER TABLE print_gateway_printer DROP COLUMN IF EXISTS branch_id")
