import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";

/**
 * Integration-test harness.
 *
 * These tests run against a REAL PostgreSQL instance (transactions,
 * FOR UPDATE SKIP LOCKED and concurrent connections cannot be faked) and are
 * skipped when DATABASE_URL is not set, so `npm test` still works on a
 * machine without a database.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/printgw_test npm test
 */
export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

let adminPool: Pool | null = null;

export function pool(): Pool {
  if (!adminPool) {
    adminPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
  }
  return adminPool;
}

// duplicate_table / duplicate_object / duplicate_column: the migration files
// are not all guarded with IF NOT EXISTS, so re-running them on an already
// migrated test database is tolerated (the schema is the same either way).
const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701"]);

export async function applyMigrations(): Promise<void> {
  const dir = path.resolve(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sqlText = readFileSync(path.join(dir, file), "utf8");
    try {
      await pool().query(sqlText);
    } catch (e: any) {
      if (!DUPLICATE_OBJECT_CODES.has(e?.code)) throw e;
    }
  }
  // Fail loudly if the schema is missing anything the tests rely on.
  const check = await pool().query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'print_jobs' AND column_name IN ('delivered_at','acked_at','delivery_attempts')`
  );
  if (check.rowCount !== 3) {
    throw new Error("test database is missing the job delivery columns (drizzle/0004_add_job_delivery_tracking.sql)");
  }
}

export async function truncateAll(): Promise<void> {
  await pool().query(`
    TRUNCATE TABLE print_jobs, printer_bindings, printers, agents, destinations,
                   document_types, local_networks, api_keys, manager_sessions,
                   auth_rate_limits, branches
    RESTART IDENTITY CASCADE
  `);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type Fixture = {
  branchId: string;
  agentId: string;
  agentSecret: string;
  agentAuth: string;
  printerId: string;
  destinationId: string;
  odooKey: string;
};

export async function seedFixture(opts?: { branchId?: string; printerCapabilities?: unknown }): Promise<Fixture> {
  const suffix = randomBytes(4).toString("hex");
  const branchId = opts?.branchId ?? `branch_${suffix}`;
  const agentId = `agt_${suffix}`;
  const agentSecret = randomBytes(16).toString("base64url");
  const printerId = `printer_${suffix}`;
  const destinationId = `dest_${suffix}`;
  const odooKey = `odoo_${randomBytes(18).toString("base64url")}`;

  await pool().query(`INSERT INTO branches (id, name) VALUES ($1, $2)`, [branchId, `Branch ${suffix}`]);
  await pool().query(
    `INSERT INTO agents (id, branch_id, name, secret, status, lifecycle) VALUES ($1, $2, $3, $4, 'online', 'active')`,
    [agentId, branchId, `Agent ${suffix}`, sha256(agentSecret)]
  );
  await pool().query(
    `INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
     VALUES ($1, $2, $3, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $4::jsonb)`,
    [printerId, agentId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]
  );
  await pool().query(
    `INSERT INTO destinations (id, branch_id, name, type) VALUES ($1, $2, 'POS', 'pos')`,
    [destinationId, branchId]
  );
  await pool().query(
    `INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'test key', $3)`,
    [`key_${suffix}`, branchId, sha256(odooKey)]
  );

  return {
    branchId,
    agentId,
    agentSecret,
    agentAuth: `Bearer ${agentId}:${agentSecret}`,
    printerId,
    destinationId,
    odooKey,
  };
}

export async function insertQueuedJob(f: Fixture, jobId: string, opts?: { expiresInMs?: number }): Promise<void> {
  await pool().query(
    `INSERT INTO print_jobs (id, branch_id, destination_id, document_type, agent_id, printer_id, status, payload, expires_at)
     VALUES ($1, $2, $3, 'receipt', $4, $5, 'queued', '{"type":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + ($6 || ' milliseconds')::interval)`,
    [jobId, f.branchId, f.destinationId, f.agentId, f.printerId, String(opts?.expiresInMs ?? 3600_000)]
  );
}

export async function jobRow(jobId: string): Promise<any> {
  const res = await pool().query(`SELECT * FROM print_jobs WHERE id = $1`, [jobId]);
  return res.rows[0];
}

export async function closePool(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
}
