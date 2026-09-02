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

/**
 * Migration ledger.
 *
 * Migrations must be applied EXACTLY ONCE, in order, exactly as in production.
 * Blindly re-running the whole directory on an already-migrated database is not
 * merely wasteful, it is wrong: 0001 re-creates `printers.branch_id` (its DDL is
 * `ADD COLUMN IF NOT EXISTS`) which 0006 has deliberately dropped, and the
 * re-added column then fails its NOT NULL/FK backfill against existing rows.
 *
 * The ledger below mirrors what a real migration runner does, so the test
 * database converges to the same schema a production database does — without
 * editing migration history.
 */
const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701"]);

async function ensureLedger(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS __test_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function applyMigrations(): Promise<void> {
  await ensureLedger();
  const applied = new Set(
    (await pool().query(`SELECT tag FROM __test_migrations`)).rows.map((r: { tag: string }) => r.tag)
  );

  const dir = path.resolve(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(path.join(dir, file), "utf8");
    try {
      await pool().query(sqlText);
    } catch (e: any) {
      // Tolerated only for a database that pre-dates the ledger (objects the
      // migration would create already exist). Anything else is a real failure.
      if (!DUPLICATE_OBJECT_CODES.has(e?.code)) throw e;
    }
    await pool().query(`INSERT INTO __test_migrations (tag) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
  }

  // Fail loudly if the schema is missing anything the tests rely on.
  const check = await pool().query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'print_jobs' AND column_name IN ('delivered_at','acked_at','delivery_attempts')`
  );
  if (check.rowCount !== 3) {
    throw new Error("test database is missing the job delivery columns (drizzle/0004_add_job_delivery_tracking.sql)");
  }
  // The ownership migration must have run: printers must NOT have a branch
  // column any more (drizzle/0006_printer_branch_via_agent.sql).
  const legacy = await pool().query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'printers' AND column_name = 'branch_id'`
  );
  if ((legacy.rowCount ?? 0) > 0) {
    throw new Error(
      "test database still has printers.branch_id — drizzle/0006_printer_branch_via_agent.sql did not apply. " +
      "A printer's branch must be derived through its agent."
    );
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
    `INSERT INTO agents (id, branch_id, name, secret, status) VALUES ($1, $2, $3, $4, 'online')`,
    [agentId, branchId, `Agent ${suffix}`, sha256(agentSecret)]
  );
  // Printers carry NO branch column: the branch comes from the owning agent
  // (Branch → Agent → Printer).
  await pool().query(
    `INSERT INTO printers (id, agent_id, name, type, connection_type, protocol, status, config, capabilities, enabled)
     VALUES ($1, $2, $3, 'spooler', 'spooler', 'spooler', 'online', '{"protocol":"spooler"}'::jsonb, $4::jsonb, true)`,
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
