import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { hashPairingCode } from "../src/lib/agent-auth";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suite = describe.skipIf(!hasDatabase);

function databaseUrlFor(name: string): string {
  const source = new URL(process.env.DATABASE_URL!);
  source.pathname = `/${name}`;
  return source.toString();
}

suite("production-like PostgreSQL migration upgrade", () => {
  let admin: Pool;
  let tempDb = "";
  let workDir = "";
  let oldDir = "";
  let currentDir = "";

  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL!);
    const adminUrl = new URL(source.toString());
    adminUrl.pathname = "/postgres";
    tempDb = `upgrade_${Date.now()}_${randomBytes(3).toString("hex")}`;
    admin = new Pool({ connectionString: adminUrl.toString(), max: 2 });
    admin.on("error", () => {});
    await admin.query(`CREATE DATABASE "${tempDb}"`);

    workDir = await mkdtemp(join(tmpdir(), "odoo-print-upgrade-"));
    oldDir = join(workDir, "old");
    currentDir = join(workDir, "current");
    await mkdir(join(oldDir, "meta"), { recursive: true });
    await mkdir(join(currentDir, "meta"), { recursive: true });

    const migrations = [
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
    ];
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const oldEntries = journal.entries.slice(0, 17);
    await writeFile(join(oldDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
    await writeFile(join(currentDir, "meta", "_journal.json"), JSON.stringify(journal));
    for (let i = 0; i < migrations.length; i += 1) {
      const target = i < 17 ? oldDir : currentDir;
      await cp(join("drizzle", migrations[i]), join(target, migrations[i]));
      if (i < 17) await cp(join("drizzle", migrations[i]), join(currentDir, migrations[i]));
    }
  });

  afterAll(async () => {
    try { await admin.query(`DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`); }
    finally { await admin.end(); if (workDir) await rm(workDir, { recursive: true, force: true }); }
  });

  it("upgrades a populated legacy database to the runtime-only architecture without losing print history", async () => {
    const pool = new Pool({ connectionString: databaseUrlFor(tempDb), max: 4 });
    pool.on("error", () => {});
    const db = drizzle(pool);
    try {
      await migrate(db, { migrationsFolder: oldDir });
      const branchId = "odoo_company_900001";
      const agentId = "agent_upgrade_fixture";
      const printerId = "printer_upgrade_fixture";
      const destinationId = "dest_upgrade_fixture";
      const bindingId = "binding_upgrade_fixture";
      const apiKeyId = "api_key_upgrade_fixture";
      const jobId = "job_upgrade_fixture";
      const hash = "a".repeat(64);

      await pool.query(`INSERT INTO branches (id, company_id, name, enabled) VALUES ($1, $2, 'Legacy Branch', true)`, [branchId, "legacy-company"]);
      await pool.query(`INSERT INTO agents (id, branch_id, name, secret, status, lifecycle) VALUES ($1, $2, 'Legacy Agent', $3, 'online', 'active')`, [agentId, branchId, "upgrade-secret-hash"]);
      const pairingAgentId = "agent_upgrade_pairing_fixture";
      await pool.query(
        `INSERT INTO agents (id, branch_id, name, secret, status, lifecycle, pairing_code, pairing_code_expires_at) VALUES ($1, $2, 'Pairing Agent', NULL, 'offline', 'active', '  ab22cd  ', now() + interval '1 hour')`,
        [pairingAgentId, branchId],
      );
      await pool.query(`INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle) VALUES ($1, $2, 'Legacy Printer', 'physical', 'thermal', 'network', 'raw', 'online', 'active')`, [printerId, agentId]);
      await pool.query(`INSERT INTO destinations (id, branch_id, name, type, enabled) VALUES ($1, $2, 'Legacy POS', 'pos', true)`, [destinationId, branchId]);
      await pool.query(`INSERT INTO printer_bindings (id, branch_id, destination_id, printer_id, priority, enabled) VALUES ($1, $2, $3, $4, 1, true)`, [bindingId, branchId, destinationId, printerId]);
      await pool.query(`INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'Legacy API key', $3)`, [apiKeyId, branchId, hash]);
      await pool.query(`INSERT INTO print_jobs (id, branch_id, destination_id, agent_id, printer_id, status, payload, expires_at, created_at, updated_at, idempotency_key, retries, delivery_attempts) VALUES ($1, $2, $3, $4, $5, 'queued', '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour', now(), now(), 'legacy-upgrade-key', 0, 0)`, [jobId, branchId, destinationId, agentId, printerId]);

      await migrate(db, { migrationsFolder: currentDir });

      const legacy = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('branches','destinations','document_types','local_networks','printer_bindings')
      `);
      expect(legacy.rows).toEqual([]);

      const legacyColumns = await pool.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('agents','printers','print_jobs','api_keys','discovery_sessions','discovered_devices')
          AND column_name IN ('branch_id','destination_id','local_network_id')
      `);
      expect(legacyColumns.rows).toEqual([]);

      const job = await pool.query(`SELECT id, agent_id, printer_id, destination, idempotency_key FROM print_jobs WHERE id=$1`, [jobId]);
      expect(job.rows).toEqual([{
        id: jobId,
        agent_id: agentId,
        printer_id: printerId,
        destination: "Legacy POS",
        idempotency_key: "legacy-upgrade-key",
      }]);

      const pairingAgent = await pool.query(`SELECT id, pairing_code_hash FROM agents WHERE id=$1`, [pairingAgentId]);
      expect(pairingAgent.rows).toEqual([{
        id: pairingAgentId,
        pairing_code_hash: hashPairingCode("AB22CD"),
      }]);

      // 0029 guarded backfill (legacy DBs carry zero tenants): exactly one
      // tenant must exist and own all of the legacy rows before any new
      // runtime row may reference them through the (tenant_id, id) FKs.
      const upgradedTenants = await pool.query(`SELECT id FROM tenants`);
      expect(upgradedTenants.rows.map((r) => r.id)).toEqual(["legacy_default"]);
      const tenantId = upgradedTenants.rows[0].id as string;

      const uniqueIndex = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='print_jobs' AND indexname='print_jobs_idempotency_unique'`);
      expect(uniqueIndex.rowCount).toBe(1);
      const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='print_jobs'::regclass AND tgname='print_jobs_notify_agent_job_available'`);
      expect(trigger.rowCount).toBe(1);

      // 0024/0025/0026 artifacts survive a real production-like upgrade path:
      const upgraded = await pool.query(`
        SELECT
          (SELECT count(*) FROM information_schema.columns WHERE table_name='print_jobs' AND column_name='claim_token') AS claim_token_col,
          (SELECT count(*) FROM pg_constraint WHERE conname='print_jobs_payload_contract_check') AS payload_check,
          (SELECT count(*) FROM pg_constraint WHERE conname='printers_protocol_check' AND pg_get_constraintdef(oid) LIKE '%unknown%') AS proto_unknown_check,
          (SELECT count(*) FROM information_schema.columns WHERE table_name='printers' AND column_name='printer_type' AND column_default LIKE '%physical%') AS printer_type_default,
          (SELECT count(*) FROM information_schema.columns WHERE table_name='printers' AND column_name='connection_type' AND column_default LIKE '%network%') AS connection_type_default
      `);
      expect(upgraded.rows[0]).toMatchObject({
        claim_token_col: "1",
        payload_check: "1",
        proto_unknown_check: "1",
        printer_type_default: "1",
        connection_type_default: "1",
      });
      // The contract CHECK is NOT VALID on purpose: the pre-0024 legacy row
      // (raw payload without protocol) keeps its history untouched...
      const legacyPayload = await pool.query(`SELECT payload FROM print_jobs WHERE id=$1`, [jobId]);
      expect(legacyPayload.rows[0].payload).toEqual({ type: "raw", encoding: "base64", data: "aA==" });
      // ...while NEW writes must declare the protocol explicitly.
      await expect(pool.query(`INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at)
        VALUES ('job_bad_contract', $1, $2, $3, 'queued', '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`, [tenantId, agentId, printerId])).rejects.toThrow(/constraint|check/i);
      await pool.query(`INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at)
        VALUES ('job_good_contract', $1, $2, $3, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`, [tenantId, agentId, printerId]);
      // 0027: Windows spooler queues reported with protocol windows_spooler
      // must sync instead of failing the CHECK with 23514.
      await pool.query(`INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle)
        VALUES ('printer_ws_fixture', $1, $2, 'Spooler Queue', 'physical', 'other', 'spooler', 'windows_spooler', 'online', 'active')`, [tenantId, agentId]);
      // 0027: SNMP-discovered Zebra/TSC candidates (zpl/tspl) must persist
      // instead of aborting the discovery session with 23514.
      await pool.query(`INSERT INTO discovery_sessions (id, tenant_id, agent_id, status) VALUES ('disc_upgrade_fixture', $1, $2, 'completed') ON CONFLICT (id) DO NOTHING`, [tenantId, agentId]);
      await pool.query(`INSERT INTO discovered_devices (id, tenant_id, discovery_id, agent_id, protocol) VALUES ('dev_zpl_fixture', $1, 'disc_upgrade_fixture', $2, 'zpl')`, [tenantId, agentId]);
      await pool.query(`INSERT INTO discovered_devices (id, tenant_id, discovery_id, agent_id, protocol) VALUES ('dev_tspl_fixture', $1, 'disc_upgrade_fixture', $2, 'tspl')`, [tenantId, agentId]);
      const devprotos = await pool.query(`SELECT protocol FROM discovered_devices WHERE id IN ('dev_zpl_fixture','dev_tspl_fixture') ORDER BY id`);
      expect(devprotos.rows.map((r) => r.protocol).sort()).toEqual(["tspl", "zpl"]);
    } finally { await pool.end(); }
  });
});
