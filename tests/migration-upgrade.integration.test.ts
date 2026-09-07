import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

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

      const uniqueIndex = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='print_jobs' AND indexname='print_jobs_idempotency_unique'`);
      expect(uniqueIndex.rowCount).toBe(1);
      const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='print_jobs'::regclass AND tgname='print_jobs_notify_agent_job_available'`);
      expect(trigger.rowCount).toBe(1);
    } finally { await pool.end(); }
  });
});
