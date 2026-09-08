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

    # runtime_agent_id column is retained on print_gateway_gateway_config as a legacy field
