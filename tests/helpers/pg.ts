import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

let adminPool: Pool | null = null;

export function pool(): Pool {
  if (!adminPool) {
    adminPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
  }
  return adminPool;
}

const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701"]);

// Single advisory key for both migrations and truncation so they never run
// concurrently and deadlock on AccessShare vs AccessExclusive locks.
const GLOBAL_PG_LOCK = 727727;

export async function applyMigrations(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      // Clean slate for the migration's branch-ownership check. Any leftover rows with
      // NULL branch_id from a previous file's direct INSERT (that omitted the column when it
      // still existed) would cause the check to fail. Truncate deterministically.
      const allTables = ["agents","api_keys","auth_rate_limits","branches","destinations","discovered_devices","discovery_sessions","document_types","local_networks","manager_sessions","printer_bindings","printers","print_jobs"];
      for (const tbl of allTables) {
        try { await client.query(`TRUNCATE TABLE "${tbl}" RESTART IDENTITY CASCADE`); } catch (e: any) { if (e?.code !== "42P01") throw e; }
      }
      const dir = path.resolve(process.cwd(), "drizzle");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sqlText = readFileSync(path.join(dir, file), "utf8");
        const statements = sqlText
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of statements) {
          try {
            await client.query(stmt);
          } catch (e: any) {
            if (!DUPLICATE_OBJECT_CODES.has(e?.code)) throw e;
          }
        }
      }
      const check = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'print_jobs' AND column_name IN ('delivered_at','acked_at','delivery_attempts')`
    );
    if (check.rowCount !== 3) {
      throw new Error("test database is missing the job delivery columns (drizzle/0004_add_job_delivery_tracking.sql)");
    }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]);
    }
  } finally {
    client.release();
  }
}

export async function truncateAll(): Promise<void> {
  const maxRetries = 4;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [GLOBAL_PG_LOCK]);
      // Discover which application tables actually exist (handles pre-migration DBs where
      // discovery tables haven't been created yet). Truncate only those that exist, in
      // alphabetical order for deterministic lock ordering.
      const res = await client.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname='public'
          AND tablename IN ('agents','api_keys','auth_rate_limits','branches','destinations','discovered_devices','discovery_sessions','document_types','local_networks','manager_sessions','printer_bindings','printers','print_jobs')
      `);
      const existing = (res.rows as { tablename: string }[]).map((r) => r.tablename).sort();
      if (existing.length > 0) {
        await client.query(`TRUNCATE TABLE ${existing.join(", ")} RESTART IDENTITY CASCADE`);
      }
      await client.query("COMMIT");
      return;
    } catch (e: any) {
      try { await client.query("ROLLBACK"); } catch {}
      const isDeadlock = e?.code === "40P01" || e?.code === "55P03";
      const isMissingTable = e?.code === "42P01";
      if (isMissingTable && attempt === 0) {
        try {
          const fallback = await pool().connect();
          try {
            await fallback.query("BEGIN");
            await fallback.query("SELECT pg_advisory_xact_lock($1)", [GLOBAL_PG_LOCK]);
            await fallback.query(`
              TRUNCATE TABLE print_jobs, printer_bindings, printers, agents, destinations, document_types, local_networks, api_keys, manager_sessions, auth_rate_limits, branches
              RESTART IDENTITY CASCADE
            `);
            await fallback.query("COMMIT");
          } finally { fallback.release(); }
          return;
        } catch {}
      }
      if (isDeadlock && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 80 * (attempt + 1) + Math.random() * 80));
        continue;
      }
      throw e;
    } finally {
      client.release();
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
  const suffix = randomBytes(4).toString("hex");
  const branchId = opts?.branchId ?? `branch_${suffix}`;
  const agentId = `agt_${suffix}`;
  const agentSecret = randomBytes(16).toString("base64url");
  const printerId = `printer_${suffix}`;
  const destinationId = `dest_${suffix}`;
  const odooKey = `odoo_${randomBytes(18).toString("base64url")}`;

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [GLOBAL_PG_LOCK]);
    await client.query(`INSERT INTO branches (id, name) VALUES ($1, $2)`, [branchId, `Branch ${suffix}`]);
    await client.query(
      `INSERT INTO agents (id, branch_id, name, secret, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, $4, 'online', 'active', now())`,
      [agentId, branchId, `Agent ${suffix}`, sha256(agentSecret)]
    );
    const hasBranchCol = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='printers' AND column_name='branch_id' LIMIT 1`
    );
    const legacyBranch = (hasBranchCol.rows?.length ?? 0) > 0 || (hasBranchCol.rowCount ?? 0) > 0;
    if (legacyBranch) {
      await client.query(
        `INSERT INTO printers (id, agent_id, branch_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
         VALUES ($1, $2, $3, $4, 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $5::jsonb)`,
        [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]
      );
    } else {
      await client.query(
        `INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
         VALUES ($1, $2, $3, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $4::jsonb)`,
        [printerId, agentId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]
      );
    }
    await client.query(
      `INSERT INTO destinations (id, branch_id, name, type) VALUES ($1, $2, 'POS', 'pos')`,
      [destinationId, branchId]
    );
    await client.query(
      `INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'test key', $3)`,
      [`key_${suffix}`, branchId, sha256(odooKey)]
    );
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }

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
  // Destination is required for FK; ensure hierarchy exists. Caller must have called seedFixture with same branch.
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
