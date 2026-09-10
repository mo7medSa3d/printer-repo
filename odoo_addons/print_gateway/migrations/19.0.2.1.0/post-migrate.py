def migrate(cr, version):
    if not version:
        return
    
    # Check if runtime_agent_id exists before attempting migration
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'print_gateway_gateway_config' AND column_name = 'runtime_agent_id'")
    if not cr.fetchone():
        return

    # Migrate legacy root-level runtime_agent_id records by inserting/updating print_gateway_binding
    # with company_id = res_company.id and branch_id = NULL (canonical root fallback binding),
    # never assigning branch_id = company_id which violates child branch hierarchy.
    cr.execute("""
        UPDATE print_gateway_binding b
        SET runtime_agent_id = c.runtime_agent_id
        FROM print_gateway_gateway_config c
        WHERE b.company_id = c.company_id
          AND b.branch_id IS NULL
          AND (b.runtime_agent_id IS NULL OR b.runtime_agent_id = '')
          AND c.runtime_agent_id IS NOT NULL AND c.runtime_agent_id != ''
    """)

    # If a company has a legacy runtime_agent_id but NO canonical root binding (branch_id IS NULL),
    # create an explicitly disabled placeholder binding (enabled = False, printer_id = 'unassigned')
    # to preserve administrative visibility of runtime_agent_id without creating fake routable hardware.
    cr.execute("""
        INSERT INTO print_gateway_binding (
            company_id, branch_id, runtime_agent_id, printer_id, destination_type,
            printer_protocol, drawer_kick_mode, cutter_mode, buzzer_mode,
            enabled, priority, create_uid, write_uid, create_date, write_date
        )
        SELECT
            c.company_id, NULL, c.runtime_agent_id, 'unassigned', 'pos',
            'unknown', 'none', 'none', 'none',
            FALSE, 999, c.create_uid, c.write_uid, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'
        FROM print_gateway_gateway_config c
        WHERE c.runtime_agent_id IS NOT NULL AND c.runtime_agent_id != ''
          AND NOT EXISTS (
              SELECT 1 FROM print_gateway_binding b 
              WHERE b.company_id = c.company_id
                AND b.branch_id IS NULL
          )
    """)

    # runtime_agent_id column is retained on print_gateway_gateway_config as a legacy field
