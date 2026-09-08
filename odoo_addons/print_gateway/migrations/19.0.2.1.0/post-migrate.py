def migrate(cr, version):
    if not version:
        return
    
    # Check if runtime_agent_id exists before attempting migration
    cr.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'print_gateway_gateway_config' AND column_name = 'runtime_agent_id'")
    if not cr.fetchone():
        return

    # Migrate the legacy runtime_agent_id to the new print_gateway_runtime_agent_assignment table
    cr.execute("""
        INSERT INTO print_gateway_runtime_agent_assignment (company_id, branch_id, runtime_agent_id, enabled)
        SELECT company_id, company_id, runtime_agent_id, enabled
        FROM print_gateway_gateway_config
        WHERE runtime_agent_id IS NOT NULL AND runtime_agent_id != ''
        ON CONFLICT (company_id, branch_id) DO NOTHING
    """)

    # runtime_agent_id column is retained on print_gateway_gateway_config as a legacy field
