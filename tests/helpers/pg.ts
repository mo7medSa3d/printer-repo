import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";
import { getWorkerSchema, schemaSearchPath } from "../../src/lib/worker-schema";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;

let adminPool: Pool | null = null;
let workerSchema: string | null | undefined = undefined;
let migrationPromise: Promise<void> | null = null;

function getOrCreateWorkerSchema(): string | null {
  if (workerSchema !== undefined) return workerSchema;
  workerSchema = getWorkerSchema();
  return workerSchema;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function pool(): Pool {
  if (!adminPool) {
    const schema = getOrCreateWorkerSchema();
    const searchPath = schema ? schemaSearchPath(schema) : null;
    const config: any = { connectionString: TEST_DATABASE_URL, max: 8 };
    if (searchPath) config.options = `-c search_path=${searchPath}`;
    adminPool = new Pool(config);
  }
  return adminPool;
}

const GLOBAL_PG_LOCK = 727727;

function rewriteMigrationForSchema(sql: string, schema: string | null): string {
  if (!schema) return sql;
  const quotedSchema = quoteIdent(schema);
  // Historical Drizzle migrations explicitly reference public.*. For isolated
  // Vitest workers those references must point at the worker schema too;
  // otherwise the migration creates local tables but tries to attach FKs to
  // public tables that intentionally do not exist in the test database.
  return sql
    .replaceAll('"public".', `${quotedSchema}.`)
    .replaceAll(/\bpublic\./g, `${schema}.`);
}

async function applyMigrationsOnce(): Promise<void> {
  const schema = getOrCreateWorkerSchema();
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      if (schema) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
        await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
        await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      }

      await client.query("BEGIN");
      const dir = path.resolve(process.cwd(), "drizzle");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sqlText = rewriteMigrationForSchema(readFileSync(path.join(dir, file), "utf8"), schema);
        const statements = sqlText
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of statements) {
          await client.query(stmt);
        }
      }

      const check = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'print_jobs'
          AND column_name IN ('delivered_at','acked_at','delivery_attempts')
      `);
      if (check.rowCount !== 3) {
        throw new Error(
          "test database is missing the job delivery columns (drizzle/0004_add_job_delivery_tracking.sql)"
        );
      }

      if (schema) {
        const fkCheck = await client.query(
          `
            SELECT conname, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conrelid IN (
              to_regclass($1),
              to_regclass($2),
              to_regclass($3)
            )
            AND contype = 'f'
          `,
          [`${schema}.agents`, `${schema}.printers`, `${schema}.print_jobs`],
        );
        for (const row of fkCheck.rows) {
          const definition = String(row.definition);
          if (definition.includes("public.")) {
            throw new Error(`worker schema FK escaped into public: ${row.conname} -> ${definition}`);
          }
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally {
    client.release();
  }
}

export async function applyMigrations(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = applyMigrationsOnce().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  await migrationPromise;
}

export async function truncateAll(): Promise<void> {
  const schema = getOrCreateWorkerSchema();
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      const tables = ["agents","api_keys","auth_rate_limits","branches","destinations","discovered_devices","discovery_sessions","document_types","local_networks","manager_sessions","printer_bindings","printers","print_jobs"];
      for (const tbl of tables) {
        try {
          await client.query(`TRUNCATE TABLE ${quoteIdent(tbl)} RESTART IDENTITY CASCADE`);
        } catch (e: any) {
          if (e?.code !== "42P01") throw e;
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally { client.release(); }
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
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      await client.query(`INSERT INTO branches (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [branchId, `Branch ${suffix}`]);
      const agentResult = await client.query(`INSERT INTO agents (id, branch_id, name, secret, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, $4, 'online', 'active', now()) ON CONFLICT (id) DO NOTHING RETURNING id`, [agentId, branchId, `Agent ${suffix}`, sha256(agentSecret)]);
      if (agentResult.rowCount !== 1) throw new Error(`failed to seed agent ${agentId}`);

      const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='printers'`);
      const has = new Set((cols.rows as { column_name: string }[]).map((r) => r.column_name));
      const hasBranch = has.has("branch_id");
      const hasType = has.has("type");
      const hasEnabled = has.has("enabled");
      if (hasBranch && hasType && hasEnabled) {
        await client.query(`INSERT INTO printers (id, agent_id, branch_id, name, type, printer_type, device_class, connection_type, protocol, status, lifecycle, enabled, config, capabilities) VALUES ($1, $2, $3, $4, 'spooler', 'physical', 'other', 'spooler', 'spooler', 'online', 'active', true, '{}'::jsonb, $5::jsonb)`, [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
      } else if (hasBranch && hasType) {
        await client.query(`INSERT INTO printers (id, agent_id, branch_id, name, type, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities) VALUES ($1, $2, $3, $4, 'spooler', 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $5::jsonb)`, [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
      } else if (hasBranch && hasEnabled) {
        await client.query(`INSERT INTO printers (id, agent_id, branch_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, enabled, config, capabilities) VALUES ($1, $2, $3, $4, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', true, '{}'::jsonb, $5::jsonb)`, [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
      } else if (hasType && hasEnabled) {
        await client.query(`INSERT INTO printers (id, agent_id, name, type, printer_type, device_class, connection_type, protocol, status, lifecycle, enabled, config, capabilities) VALUES ($1, $2, $3, 'spooler', 'physical', 'other', 'spooler', 'spooler', 'online', 'active', true, '{}'::jsonb, $4::jsonb)`, [printerId, agentId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
      } else if (hasBranch) {
        await client.query(`INSERT INTO printers (id, agent_id, branch_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities) VALUES ($1, $2, $3, $4, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $5::jsonb)`, [printerId, agentId, branchId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] })]);
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
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally { client.release(); }
  return { branchId, agentId, agentSecret, agentAuth: `Bearer ${agentId}:${agentSecret}`, printerId, destinationId, odooKey };
}

export async function insertQueuedJob(f: Fixture, jobId: string, opts?: { expiresInMs?: number }): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      await client.query(`INSERT INTO print_jobs (id, branch_id, destination_id, document_type, agent_id, printer_id, status, payload, expires_at) VALUES ($1, $2, $3, 'receipt', $4, $5, 'queued', '{"type":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + ($6 || ' milliseconds')::interval)`, [jobId, f.branchId, f.destinationId, f.agentId, f.printerId, String(opts?.expiresInMs ?? 3600_000)]);
      await client.query("COMMIT");
    } catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; } finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
}

export async function jobRow(jobId: string): Promise<any> {
  const res = await pool().query(`SELECT * FROM print_jobs WHERE id = $1`, [jobId]);
  return res.rows[0];
}

export async function closePool(): Promise<void> {
  if (adminPool) { await adminPool.end(); adminPool = null; }
}
