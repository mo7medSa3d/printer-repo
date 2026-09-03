import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";
import { getWorkerSchema, schemaSearchPath } from "@/lib/worker-schema";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

let adminPool: Pool | null = null;
let workerSchema: string | null | undefined = undefined;

function getOrCreateWorkerSchema(): string | null {
  if (workerSchema !== undefined) return workerSchema;
  workerSchema = getWorkerSchema();
  return workerSchema;
}

export function pool(): Pool {
  if (!adminPool) {
    const schema = getOrCreateWorkerSchema();
    const searchPath = schema ? schemaSearchPath(schema) : null;
    const config: any = { connectionString: TEST_DATABASE_URL, max: 8 };
    if (searchPath) config.options = `-c search_path=${searchPath}`;
    adminPool = new Pool(config);
    // Eagerly ensure the schema exists; ignore errors if it already does.
    if (schema) {
      adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`).catch(() => {});
    }
  }
  return adminPool;
}

const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701"]);

export async function applyMigrations(): Promise<void> {
  // With per-worker schema isolation, each worker has its own empty schema.
  // No global lock is needed — the schema is private to this worker.
  // Ensure the worker schema exists and is used via search_path (configured on pool).
  const schema = getOrCreateWorkerSchema();
  if (schema) {
    await pool().query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }
  const dir = path.resolve(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sqlText = readFileSync(path.join(dir, file), "utf8");
    const statements = sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await pool().query(stmt);
      } catch (e: any) {
        if (!DUPLICATE_OBJECT_CODES.has(e?.code)) throw e;
      }
    }
  }
  const check = await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'print_jobs' AND column_name IN ('delivered_at','acked_at','delivery_attempts')`);
  if (check.rowCount !== 3) throw new Error("test database is missing the job delivery columns (drizzle/0004_add_job_delivery_tracking.sql)");
}

export async function truncateAll(): Promise<void> {
  // Per-worker schema means truncate only touches this worker's tables.
  // No advisory lock or retry needed — there is no cross-worker contention.
  // Use a single TRUNCATE that handles all known tables; ignore 42P01 for tables
  // that haven't been created yet (e.g., discovered_devices before 0010).
  const tables = ["agents","api_keys","auth_rate_limits","branches","destinations","discovered_devices","discovery_sessions","document_types","local_networks","manager_sessions","printer_bindings","printers","print_jobs"];
  for (const tbl of tables) {
    try {
      await pool().query(`TRUNCATE TABLE "${tbl}" RESTART IDENTITY CASCADE`);
    } catch (e: any) {
      if (e?.code !== "42P01") throw e;
    }
  }
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
  const suffix = randomBytes(8).toString("hex");
  const branchId = opts?.branchId ?? `branch_${suffix}`;
  const agentId = `agt_${suffix}`;
  const agentSecret = randomBytes(16).toString("base64url");
  const printerId = `printer_${suffix}`;
  const destinationId = `dest_${suffix}`;
  const odooKey = `odoo_${randomBytes(18).toString("base64url")}`;
  // With per-worker schema isolation, no global lock is needed. Use a single
  // transaction so the Branch→Agent→Printer→Destination→api_keys hierarchy is
  // created atomically per test.
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO branches (id, name) VALUES ($1, $2)`, [branchId, `Branch ${suffix}`]);
    await client.query(`INSERT INTO agents (id, branch_id, name, secret, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, $4, 'online', 'active', now())`, [agentId, branchId, `Agent ${suffix}`, sha256(agentSecret)]);
    const hasBranchCol = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='printers' AND column_name='branch_id' LIMIT 1`);
    const legacyBranch = (hasBranchCol.rows?.length ?? 0) > 0 || (hasBranchCol.rowCount ?? 0) > 0;
    if (legacyBranch) {
      await client.query(`INSERT INTO printers (id, agent_id, branch_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities) VALUES ($1, $2, $3, $4, 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $5::jsonb)`, [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
    } else {
      await client.query(`INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities) VALUES ($1, $2, $3, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $4::jsonb)`, [printerId, agentId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
    }
    await client.query(`INSERT INTO destinations (id, branch_id, name, type) VALUES ($1, $2, 'POS', 'pos')`, [destinationId, branchId]);
    await client.query(`INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'test key', $3)`, [`key_${suffix}`, branchId, sha256(odooKey)]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
  return { branchId, agentId, agentSecret, agentAuth: `Bearer ${agentId}:${agentSecret}`, printerId, destinationId, odooKey };
}

export async function insertQueuedJob(f: Fixture, jobId: string, opts?: { expiresInMs?: number }): Promise<void> {
  // No advisory lock needed with per-worker schema; the job belongs to the fixture's isolated schema.
  await pool().query(`INSERT INTO print_jobs (id, branch_id, destination_id, document_type, agent_id, printer_id, status, payload, expires_at) VALUES ($1, $2, $3, 'receipt', $4, $5, 'queued', '{"type":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + ($6 || ' milliseconds')::interval)`, [jobId, f.branchId, f.destinationId, f.agentId, f.printerId, String(opts?.expiresInMs ?? 3600_000)]);
}

export async function jobRow(jobId: string): Promise<any> {
  const res = await pool().query(`SELECT * FROM print_jobs WHERE id = $1`, [jobId]);
  return res.rows[0];
}

export async function closePool(): Promise<void> {
  if (adminPool) { await adminPool.end(); adminPool = null; }
}
