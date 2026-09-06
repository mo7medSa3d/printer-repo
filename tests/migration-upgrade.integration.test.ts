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
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  it("applies current migration 0017 over an existing populated 0016 database without data loss", async () => {
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
      await pool.query(`INSERT INTO destinations (id, branch_id, name, destination_type, enabled) VALUES ($1, $2, 'Legacy POS', 'pos', true)`, [destinationId, branchId]);
      await pool.query(`INSERT INTO printer_bindings (id, branch_id, destination_id, printer_id, priority, enabled) VALUES ($1, $2, $3, $4, 1, true)`, [bindingId, branchId, destinationId, printerId]);
      await pool.query(`INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'Legacy API key', $3)`, [apiKeyId, branchId, hash]);
      await pool.query(`INSERT INTO print_jobs (id, branch_id, destination_id, agent_id, printer_id, status, payload, expires_at, created_at, updated_at, idempotency_key, retries, delivery_attempts) VALUES ($1, $2, $3, $4, $5, 'queued', '{}'::jsonb, now() + interval '1 hour', now(), now(), 'legacy-upgrade-key', 0, 0)`, [jobId, branchId, destinationId, agentId, printerId]);

      const before = await pool.query(`
        SELECT b.id AS branch_id, a.id AS agent_id, a.name AS agent_name, p.id AS printer_id,
               d.id AS destination_id, pb.id AS binding_id, k.id AS api_key_id,
               j.id AS job_id, j.idempotency_key
        FROM branches b
        JOIN agents a ON a.branch_id = b.id
        JOIN printers p ON p.agent_id = a.id
        JOIN destinations d ON d.branch_id = b.id
        JOIN printer_bindings pb ON pb.branch_id = b.id AND pb.destination_id = d.id AND pb.printer_id = p.id
        JOIN api_keys k ON k.branch_id = b.id
        JOIN print_jobs j ON j.printer_id = p.id
        WHERE b.id = $1
      `, [branchId]);
      expect(before.rowCount).toBe(1);
      expect(before.rows[0]).toMatchObject({
        branch_id: branchId,
        agent_id: agentId,
        agent_name: "Legacy Agent",
        printer_id: printerId,
        destination_id: destinationId,
        binding_id: bindingId,
        api_key_id: apiKeyId,
        job_id: jobId,
        idempotency_key: "legacy-upgrade-key",
      });

      await migrate(db, { migrationsFolder: currentDir });

      const after = await pool.query(`
        SELECT b.id AS branch_id, a.id AS agent_id, a.name AS agent_name, p.id AS printer_id,
               d.id AS destination_id, pb.id AS binding_id, k.id AS api_key_id,
               j.id AS job_id, j.idempotency_key
        FROM branches b
        JOIN agents a ON a.branch_id = b.id
        JOIN printers p ON p.agent_id = a.id
        JOIN destinations d ON d.branch_id = b.id
        JOIN printer_bindings pb ON pb.branch_id = b.id AND pb.destination_id = d.id AND pb.printer_id = p.id
        JOIN api_keys k ON k.branch_id = b.id
        JOIN print_jobs j ON j.printer_id = p.id
        WHERE b.id = $1
      `, [branchId]);
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]).toMatchObject({
        branch_id: branchId,
        agent_id: agentId,
        agent_name: "Legacy Agent",
        printer_id: printerId,
        destination_id: destinationId,
        binding_id: bindingId,
        api_key_id: apiKeyId,
        job_id: jobId,
        idempotency_key: "legacy-upgrade-key",
      });

      const trigger = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'print_jobs'::regclass AND tgname = 'trg_print_jobs_notify_queued'`);
      expect(trigger.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
