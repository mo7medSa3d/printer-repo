# FINAL_AUDIT_CHECKLIST.md (Phase 17, 2026-09-13)

Legend: [PASS]=line-reviewed, no defect. [FIXED]=defect fixed this cycle. [NOT VERIFIED]=needs runtime not available here. [BLOCKED]=environment-blocked.

## .
- [NOT VERIFIED] `.dockerignore`
- [NOT VERIFIED] `.env.docker.example`
- [FIXED] `.env.example`
- [NOT VERIFIED] `.gitignore`
- [PASS] (manifest reviewed) `.node-version`
- [PASS] (manifest reviewed) `.npmrc`
- [PASS] (manifest reviewed) `.nvmrc`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `API.md`
- [FIXED] `ARCHITECTURE.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `ARCHITECTURE_DECISIONS.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `AUDIT_REPORT_2026-09.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `CURRENT_ARCHITECTURE_REPORT.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `CURRENT_STATE.md`
- [PASS] `Caddyfile`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DEPLOYMENT_STAMPS.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DESIGN_SYSTEM.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DOCKER_DEPLOYMENT.md`
- [FIXED] `DOCS.md`
- [PASS] `Dockerfile`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `EXHAUSTIVE_FORENSIC_AUDIT_2026-09-13.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `FINAL_ARCHITECTURE_AUDIT_2026-09.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `FINAL_GATE_CHECKLIST_2026-09-13.md`
- [NOT VERIFIED] `FINAL_SOURCE_MANIFEST_2026-09-13.sha256`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `FINAL_VERIFICATION_REPORT.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `FORENSIC_FIX_VALIDATION_2026-09-11.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `FULL_PROJECT_STRUCTURE_2026-09-13.txt`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `INSTALLATION.md`
- [NOT VERIFIED] `LICENSE`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `MIGRATION_PLAN.md`
- [FIXED] `OPERATIONS.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `PRINCIPAL_AUDIT_2026-09.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `PRINTERS.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `README.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `SECURITY_MODEL.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `TARGET_ARCHITECTURE.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `TENANT_ISOLATION_MODEL.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `THIRD_PARTY_NOTICES.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `TROUBLESHOOTING.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `WINDOWS_PHYSICAL_E2E.md`
- [FIXED] `docker-compose.yml`
- [NOT VERIFIED] `drizzle.config.ts`
- [PASS] `eslint.config.mjs`
- [NOT VERIFIED] `next-env.d.ts`
- [PASS] `next.config.ts`
- [PASS] (manifest reviewed) `package-lock.json`
- [PASS] `package.json`
- [NOT VERIFIED] `postcss.config.mjs`
- [FIXED] `server.ts`
- [PASS] `tsconfig.json`
- [NOT VERIFIED] `vite.desktop.config.mts`
- [PASS] `vitest.config.mts`
- [PASS] `vitest.integration.config.mts`

## .github/workflows
- [PASS] `build-windows.yml`
- [PASS] `ci.yml`
- [PASS] `docker-build.yml`
- [PASS] `docker-runtime-smoke.yml`
- [PASS] `main-governance.yml`
- [PASS] `security-supply-chain.yml`

## agent
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `EMBEDDED_PDFIUM.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `EMBEDDED_PDFIUM_VERIFICATION_2026-09-11.md`
- [NOT VERIFIED] `Makefile`
- [NOT VERIFIED] `go.mod`
- [PASS] (manifest reviewed) `go.sum`

## agent/cmd/agent
- [PASS] `main.go`

## agent/cmd/cli
- [PASS] `cleanup.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `cleanup_test.go`
- [PASS] `helpers.go`
- [PASS] `main.go`

## agent/configs
- [FIXED] `config.yaml.example`

## agent/internal/agent
- [PASS] `agent.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `agent_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `discovery_bounded_test.go`
- [PASS] `discovery_manager.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `discovery_manager_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `dispatch_test.go`
- [PASS] `pairing.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `pairing_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `ws_delivery_test.go`

## agent/internal/config
- [PASS] `config.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `config_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `replace_file_posix.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `replace_file_windows.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `reprint_policy_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `security_other.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `security_windows.go`

## agent/internal/diag
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `diag_test.go`

## agent/internal/integration
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `crash_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `failure_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `mock_e2e_test.go`

## agent/internal/payload
- [PASS] `payload.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `payload_test.go`

## agent/internal/printer
- [PASS] `capability.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `capability_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `classify.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `classify_device.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `classify_device_test.go`
- [PASS] `discovery.go`
- [PASS] `discovery_extended.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `discovery_extended_test.go`
- [PASS] (go vet/build/test/race PASS where runnable) `discovery_other.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `discovery_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `discovery_windows.go`
- [PASS] `document.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `document_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `document_timeout_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `factory.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `hardening_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `health.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `health_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `image.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `image_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `ipp.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `ipp_discovery.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `ipp_test.go`
- [PASS] `network.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `network_discovery.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `network_integration_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `network_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `outcome.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `outcome_test.go`
- [PASS] `pdf.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `pdf_other.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `pdf_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `pdf_windows.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `pdf_windows_test.go`
- [PASS] `peripherals.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `peripherals_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `printer.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `raster_capability.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `raster_capability_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `registry.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `results_close_race_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `snmp_discovery.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `spooler_stub.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `spooler_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `spooler_windows.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `spooler_windows_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `stable_id.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `usb_other.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `usb_windows.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `usb_windows_test.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `wsd_discovery.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `wsd_probe_test.go`

## agent/internal/queue
- [PASS] `cleanup.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `cleanup_test.go`
- [PASS] `queue.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `queue_test.go`

## agent/internal/storage
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `replace_file_posix.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `replace_file_windows.go`
- [PASS] `secure.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `secure_posix.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `secure_test.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `secure_windows.go`
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `security_other.go`
- [PASS] `security_windows.go`
- [NOT VERIFIED] (Windows-only / test companion; cross-compile PASS) `security_windows_test.go`

## agent/internal/testutil
- [NOT VERIFIED] (structural review only) (go vet/build/test/race PASS where runnable) `mock_printer.go`

## docs
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `AGENT.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `ARCHITECTURE.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `CONFIGURATION.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DATABASE.md`
- [FIXED] `DEPLOYMENT.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DESKTOP.md`
- [FIXED] `DEVELOPMENT.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `DISCOVERY.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `JOB_LIFECYCLE.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `ODOO.md`
- [FIXED] `PRODUCTION_READINESS.md`
- [FIXED] `PRODUCTION_TLS.md`
- [FIXED] `SECURITY.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `TESTING.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `TROUBLESHOOTING.md`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `WEBSOCKET_PROTOCOL.md`

## drizzle
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0000_simple_tigra.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0001_phase1_branch_foundation.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0002_add_document_types.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0003_add_idempotency_key.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0004_add_job_delivery_tracking.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0005_auth_rate_limits.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0006_architecture_hardening.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0007_auth_rate_limit_retention.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0008_remove_pcl_contract.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0009_runtime_invariant_guard.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0010_discovery.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0011_worker_schema_fk_hardening.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0012_runtime_state_checks.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0013_runtime_state_constraint_scope_fix.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0014_discovery_state_checks.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0015_metrics_and_agent_notifications.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0016_print_job_rate_limits.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0017_notify_requeued_jobs.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0018_global_print_job_idempotency.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0019_drop_legacy_print_destination_fk.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0020_remove_gateway_business_ownership.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0021_scope_print_jobs_to_api_key.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0022_pairing_code_hash.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0023_internal_print_job_idempotency.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0024_claim_fencing_and_payload_contract.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0025_constraint_scope_and_protocol_contract_fix.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0026_printer_type_default_alignment.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0027_printers_protocol_check_windows_spooler.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0028_add_multi_tenancy.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0029_enforce_tenant_id_not_null.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0030_tenant_domains_and_manager_sessions.sql`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0031_enforce_tenant_cross_table_foreign_keys.sql`

## drizzle/meta
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0000_snapshot.json`
- [NOT VERIFIED] (SQL apply BLOCKED: no psql; journal mapping verified 1:1) `0028_snapshot.json`
- [FIXED] `_journal.json`

## odoo_addons/print_gateway
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `__init__.py`
- [PASS] `__manifest__.py`

## odoo_addons/print_gateway/controllers
- [PASS] `__init__.py`
- [PASS] `pos.py`
- [PASS] `report_download_override.py`
- [PASS] `runtime_printers.py`

## odoo_addons/print_gateway/data
- [PASS] `cron.xml`

## odoo_addons/print_gateway/migrations
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `__init__.py`

## odoo_addons/print_gateway/migrations/1.1.0
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `__init__.py`
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `pre-migrate.py`

## odoo_addons/print_gateway/migrations/19.0.1.1.0
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `__init__.py`
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `pre-migrate.py`

## odoo_addons/print_gateway/migrations/19.0.2.1.0
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `__init__.py`
- [NOT VERIFIED] (py_compile PASS; needs Odoo runtime) `post-migrate.py`

## odoo_addons/print_gateway/models
- [PASS] `__init__.py`
- [PASS] `account_move.py`
- [PASS] `binding.py`
- [PASS] `crypto.py`
- [PASS] `gateway_config.py`
- [PASS] `ir_actions_report.py`
- [PASS] `pos_order.py`
- [PASS] `pos_session.py`
- [PASS] `print_intent.py`
- [FIXED] `print_job.py`
- [PASS] `print_policy.py`
- [PASS] `print_router.py`
- [PASS] `runtime_assignment.py`
- [PASS] `stock_picking.py`

## odoo_addons/print_gateway/security
- [PASS] `ir.model.access.csv`
- [PASS] `security.xml`

## odoo_addons/print_gateway/static/description
- [PASS] (binary asset, hash recorded) `icon.png`
- [NOT VERIFIED] `index.html`

## odoo_addons/print_gateway/static/src/components
- [NOT VERIFIED] `runtime_agent_field.js`
- [NOT VERIFIED] `runtime_printer_field.js`

## odoo_addons/print_gateway/static/src/js
- [NOT VERIFIED] `pos_print_router.js`
- [NOT VERIFIED] `pos_sale_details_router.js`
- [NOT VERIFIED] `report_interceptor.js`

## odoo_addons/print_gateway/static/src/js/tours
- [NOT VERIFIED] `binding_cascade_tour.js`

## odoo_addons/print_gateway/static/src/scss
- [NOT VERIFIED] `print_gateway_backend.scss`
- [NOT VERIFIED] `print_gateway_tokens.scss`

## odoo_addons/print_gateway/tests
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `__init__.py`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `test_architecture_contract.py`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `test_branch_runtime_binding.py`
- [FIXED] `test_control_plane.py`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `test_gateway_url_transport.py`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `test_migration_upgrade.py`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `test_routing_contract.py`

## odoo_addons/print_gateway/views
- [NOT VERIFIED] `binding_views.xml`
- [NOT VERIFIED] `gateway_config_views.xml`
- [NOT VERIFIED] `menu.xml`
- [NOT VERIFIED] `print_intent_views.xml`
- [NOT VERIFIED] `print_job_views.xml`
- [NOT VERIFIED] `print_policy_views.xml`
- [NOT VERIFIED] `runtime_assignment_views.xml`

## scripts
- [NOT VERIFIED] `backfill_tenants.ts`
- [NOT VERIFIED] `build-windows-installer.ps1`
- [NOT VERIFIED] `db-migrate.ts`
- [NOT VERIFIED] `generate-icons.mjs`
- [NOT VERIFIED] `pg-concurrent-claim.sh`
- [NOT VERIFIED] `pg-notify-failure-injection.ts`
- [NOT VERIFIED] `smoke-test-windows.ps1`

## src-tauri
- [NOT VERIFIED] `Cargo.lock`
- [PASS] `Cargo.toml`
- [NOT VERIFIED] (doc claim — see doc-consistency section of findings) `README.md`
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `build.rs`
- [NOT VERIFIED] `installer_hooks.nsh`
- [NOT VERIFIED] `rust-toolchain.toml`
- [PASS] `tauri.conf.json`

## src-tauri/capabilities
- [PASS] `default.json`

## src-tauri/icons
- [PASS] (binary asset, hash recorded) `128x128.png`
- [PASS] (binary asset, hash recorded) `128x128@2x.png`
- [PASS] (binary asset, hash recorded) `16x16.png`
- [PASS] (binary asset, hash recorded) `24x24.png`
- [PASS] (binary asset, hash recorded) `32x32.png`
- [PASS] (binary asset, hash recorded) `48x48.png`
- [PASS] (binary asset, hash recorded) `64x64.png`
- [PASS] (binary asset, hash recorded) `icon-source.svg`
- [PASS] (binary asset, hash recorded) `icon.ico`
- [PASS] (binary asset, hash recorded) `icon.png`

## src-tauri/src
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `agent.rs`
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `cleanup.rs`
- [PASS] `commands.rs`
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `logging.rs`
- [PASS] `main.rs`
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `paths.rs`
- [NOT VERIFIED] (not compiled here; crates.io fetch forbidden) `tray.rs`

## src/app
- [FIXED] `actions.ts`
- [NOT VERIFIED] `error.tsx`
- [NOT VERIFIED] `globals.css`
- [NOT VERIFIED] (structural review only) (binary asset, hash recorded) `icon.svg`
- [PASS] `layout.tsx`
- [NOT VERIFIED] `loading.tsx`
- [NOT VERIFIED] `not-found.tsx`
- [PASS] `page.tsx`

## src/app/api-keys
- [PASS] `page.tsx`

## src/app/api/agent/discovery
- [PASS] `route.ts`

## src/app/api/agent/heartbeat
- [PASS] `route.ts`

## src/app/api/agent/jobs
- [PASS] `route.ts`

## src/app/api/agent/register
- [PASS] `route.ts`

## src/app/api/agents
- [PASS] `route.ts`

## src/app/api/agents/[id]
- [PASS] `route.ts`

## src/app/api/agents/[id]/discovered-printers/[deviceId]/provision
- [PASS] `route.ts`

## src/app/api/agents/[id]/discovered-printers/[deviceId]/verify
- [PASS] `route.ts`

## src/app/api/agents/[id]/discovery
- [PASS] `route.ts`

## src/app/api/agents/[id]/discovery/[discoveryId]
- [PASS] `route.ts`

## src/app/api/agents/[id]/discovery/[discoveryId]/cancel
- [PASS] `route.ts`

## src/app/api/auth/manager/login
- [PASS] `route.ts`

## src/app/api/auth/manager/logout
- [PASS] `route.ts`

## src/app/api/auth/manager/me
- [PASS] `route.ts`

## src/app/api/health
- [PASS] `route.ts`

## src/app/api/jobs
- [PASS] `route.ts`

## src/app/api/jobs/[id]
- [PASS] `route.ts`

## src/app/api/metrics
- [PASS] `route.ts`

## src/app/api/odoo/agents
- [PASS] `route.ts`

## src/app/api/odoo/health
- [PASS] `route.ts`

## src/app/api/odoo/keys
- [PASS] `route.ts`

## src/app/api/odoo/printers
- [PASS] `route.ts`

## src/app/api/print/jobs
- [PASS] `route.ts`

## src/app/api/print/jobs/batch-status
- [PASS] `route.ts`

## src/app/api/printers
- [PASS] `route.ts`

## src/app/api/printers/[id]
- [PASS] `route.ts`

## src/app/api/printers/[id]/test-connection
- [PASS] `route.ts`

## src/app/api/printers/[id]/test-print
- [FIXED] `route.ts`

## src/app/dashboard
- [FIXED] `dashboard-client.tsx`
- [FIXED] `page.tsx`

## src/app/login
- [PASS] `page.tsx`

## src/components
- [NOT VERIFIED] `AppShell.tsx`
- [PASS] `HeaderNav.tsx`
- [PASS] `JobCleanupButton.tsx`
- [NOT VERIFIED] `brand.tsx`
- [NOT VERIFIED] `ui.tsx`

## src/db
- [PASS] `index.ts`
- [FIXED] `schema.ts`
- [PASS] `tenant.ts`

## src/desktop
- [NOT VERIFIED] `index.html`
- [NOT VERIFIED] `main.tsx`
- [NOT VERIFIED] `preview.html`
- [NOT VERIFIED] `theme-light.css`
- [NOT VERIFIED] `types.ts`
- [NOT VERIFIED] `ui.tsx`

## src/desktop/components
- [NOT VERIFIED] `AddPrinterDialog.tsx`
- [NOT VERIFIED] `AdminPrivilegeDialog.tsx`
- [NOT VERIFIED] `JobTimeline.tsx`
- [NOT VERIFIED] `Sidebar.tsx`

## src/desktop/lib
- [NOT VERIFIED] `ipc.ts`
- [NOT VERIFIED] `printers.ts`

## src/desktop/pages
- [NOT VERIFIED] `Agents.tsx`
- [NOT VERIFIED] `Jobs.tsx`
- [NOT VERIFIED] `Overview.tsx`
- [NOT VERIFIED] `Printers.tsx`
- [NOT VERIFIED] `Settings.tsx`

## src/desktop/preview
- [NOT VERIFIED] `main.ts`
- [NOT VERIFIED] `mock-tauri.ts`

## src/lib
- [PASS] `action-error.ts`
- [PASS] `agent-auth.ts`
- [PASS] `agent-availability.ts`
- [FIXED] `agent-lifecycle.ts`
- [PASS] `auth-rate-limit.ts`
- [FIXED] `canonicalize.ts`
- [PASS] `clipboard.ts`
- [PASS] `discovery.ts`
- [PASS] `job-delivery.ts`
- [PASS] `job-fencing.ts`
- [PASS] `job-maintenance.ts`
- [PASS] `job-status.ts`
- [PASS] `lifecycle.ts`
- [PASS] `log.ts`
- [PASS] `manager-auth.ts`
- [PASS] `metrics.ts`
- [PASS] `network-address.ts`
- [PASS] `odoo-auth.ts`
- [PASS] `payload.ts`
- [PASS] `print-job-service.ts`
- [PASS] `printer-model.ts`
- [PASS] `printer-virtual.ts`
- [PASS] `request-limits.ts`
- [PASS] `routing.ts`
- [PASS] `runtime-secret.ts`
- [PASS] `utils.ts`
- [PASS] `worker-schema.ts`
- [PASS] `ws-rate-limit.ts`

## src/server
- [PASS] `cors.ts`
- [PASS] `request-guard.ts`
- [PASS] `trusted-proxy.ts`
- [FIXED] `ws.ts`

## src/shared
- [PASS] `job-vocabulary.ts`

## src/shared/components
- [PASS] `StatusDot.tsx`

## src/shared/lib
- [NOT VERIFIED] `format.ts`

## tests
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `admin-privilege-dialog.test.ts`
- [FIXED] `agent-deletion.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `agent-registration.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `architectural-constraints-and-statuses.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `architecture-hardening.test.ts`
- [FIXED] `architecture-pg.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `auth-rate-limit.test.ts`
- [FIXED] `batch-status.test.ts`
- [FIXED] `ci-tripwire.check.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `clipboard.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `defect-remediation-exhaustive.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `deployment-security-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `desktop-auth-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `desktop-ui-smoke.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `dialog-isolation.test.ts`
- [FIXED] `discovery-approval.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `discovery-security.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `discovery-unit.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `e2e-job-flow.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `gateway-runtime-architecture.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `health.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `heartbeat-enabled.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `job-cleanup-contract.test.ts`
- [FIXED] `job-maintenance.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `job-status-postgres-concurrency.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `job-status.test.ts`
- [FIXED] `legacy-print-authorization.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `lifecycle-delivery.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `manager-auth.test.ts`
- [FIXED] `migration-upgrade.integration.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `multi-instance-gateway.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `network-address.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `odoo-addon-static.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `odoo-auth-database-optional.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `odoo-simulation.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `pairing-code-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `payload.test.ts`
- [FIXED] `pg-concurrent-claim.mjs`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `phase2-routing-fallback.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `physical-outcome.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `print-idempotency.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `printer-virtual.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `production-fixes-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `production-hardening-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `request-guard-http.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `requeue-notify-contract.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `routing-availability.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `routing-doctype-parity.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `routing-virtual-regression.test.ts`
- [FIXED] `runtime-constraints.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `server-http-acceptance.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `tenant-isolation.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `trusted-proxy.test.ts`
- [FIXED] `ws-claim-delivery.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `ws-listener-setup-race.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `ws-route-ownership.test.ts`
- [NOT VERIFIED] (suite not executable here: no node_modules/DB; CI must run) `ws-socket-cap.test.ts`

## tests/helpers
- [NOT VERIFIED] `pg.ts`
