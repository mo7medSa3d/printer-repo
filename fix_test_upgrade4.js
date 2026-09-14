const fs = require('fs');
let file = fs.readFileSync('tests/migration-upgrade.integration.test.ts', 'utf8');
const oldMigrationsArray = `    const migrations = [
      "0000_simple_tigra.sql", "0001_phase1_branch_foundation.sql", "0002_add_document_types.sql",
      "0003_add_idempotency_key.sql", "0004_add_job_delivery_tracking.sql", "0005_auth_rate_limits.sql",
      "0006_architecture_hardening.sql", "0007_auth_rate_limit_retention.sql", "0008_remove_pcl_contract.sql",
      "0009_runtime_invariant_guard.sql", "0010_discovery.sql", "0011_worker_schema_fk_hardening.sql",
      "0012_runtime_state_checks.sql", "0013_runtime_state_constraint_scope_fix.sql", "0014_discovery_state_checks.sql",
      "0015_metrics_and_agent_notifications.sql", "0016_print_job_rate_limits.sql", "0017_notify_requeued_jobs.sql",
      "0018_global_print_job_idempotency.sql", "0019_drop_legacy_print_destination_fk.sql", "0020_remove_gateway_business_ownership.sql",
      "0021_scope_print_jobs_to_api_key.sql", "0022_pairing_code_hash.sql",
      "0023_internal_print_job_idempotency.sql",
      "0024_claim_fencing_and_payload_contract.sql",
      "0025_constraint_scope_and_protocol_contract_fix.sql",
      "0026_printer_type_default_alignment.sql",
      "0027_printers_protocol_check_windows_spooler.sql",
      "0028_add_multi_tenancy.sql",
      "0029_enforce_tenant_id_not_null.sql",
      "0030_tenant_domains_and_manager_sessions.sql",
      "0031_enforce_tenant_cross_table_foreign_keys.sql",
      "0032_pairing_code_hash_unique.sql",
    ];`;
const newMigrationsArray = `    const migrations = [
      "0000_simple_tigra.sql", "0001_phase1_branch_foundation.sql", "0002_add_document_types.sql",
      "0003_add_idempotency_key.sql", "0004_add_job_delivery_tracking.sql", "0005_auth_rate_limits.sql",
      "0006_architecture_hardening.sql", "0007_auth_rate_limit_retention.sql", "0008_remove_pcl_contract.sql",
      "0009_runtime_invariant_guard.sql", "0010_discovery.sql", "0011_worker_schema_fk_hardening.sql",
      "0012_runtime_state_checks.sql", "0013_runtime_state_constraint_scope_fix.sql", "0014_discovery_state_checks.sql",
      "0015_metrics_and_agent_notifications.sql", "0016_print_job_rate_limits.sql", "0017_notify_requeued_jobs.sql",
      "0018_global_print_job_idempotency.sql", "0019_drop_legacy_print_destination_fk.sql", "0020_remove_gateway_business_ownership.sql",
      "0021_scope_print_jobs_to_api_key.sql", "0022_pairing_code_hash.sql",
      "0023_internal_print_job_idempotency.sql",
      "0024_claim_fencing_and_payload_contract.sql",
      "0025_constraint_scope_and_protocol_contract_fix.sql",
      "0026_printer_type_default_alignment.sql",
      "0027_printers_protocol_check_windows_spooler.sql",
      "0028_add_multi_tenancy.sql",
      "0029_enforce_tenant_id_not_null.sql",
      "0030_tenant_domains_and_manager_sessions.sql",
      "0031_enforce_tenant_cross_table_foreign_keys.sql",
      "0032_pairing_code_hash_unique.sql",
      "0033_manager_identity.sql",
      "0034_saas_control_plane.sql",
      "0035_tenant_membership_role_check.sql",
      "0036_print_job_request_id.sql",
      "0037_flawless_madame_masque.sql",
    ];`;
file = file.replace(oldMigrationsArray, newMigrationsArray);
file = file.replace('const oldEntries = journal.entries.slice(0, 17);', 'const oldEntries = journal.entries.slice(0, 38);');
file = file.replace('if (i < 17) await cp(join("drizzle", migrations[i]), join(oldDir, migrations[i]));', 'if (i < 38) await cp(join("drizzle", migrations[i]), join(oldDir, migrations[i]));');
file = file.replace('const target = i < 17 ? oldDir : currentDir;', 'const target = i < 38 ? oldDir : currentDir;');
file = file.replace('if (i < 17) await cp(join("drizzle", migrations[i]), join(currentDir, migrations[i]));', 'if (i < 38) await cp(join("drizzle", migrations[i]), join(currentDir, migrations[i]));');
fs.writeFileSync('tests/migration-upgrade.integration.test.ts', file);
