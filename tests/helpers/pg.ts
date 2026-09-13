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
function quoteIdent(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
export function pool(): Pool {
  if (!adminPool) {
    const schema = getOrCreateWorkerSchema();
    const config: any = { connectionString: TEST_DATABASE_URL, max: 8 };
    if (schema) config.options = `-c search_path=${schemaSearchPath(schema)}`;
    adminPool = new Pool(config);
  }
  return adminPool;
}

const GLOBAL_PG_LOCK = 727727;
function rewriteMigrationForSchema(sql: string, schema: string | null): string {
  if (!schema) return sql;
  const quotedSchema = quoteIdent(schema);
  return sql.replaceAll('"public".', `${quotedSchema}.`).replaceAll(/\bpublic\./g, `${schema}.`);
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
        for (const statement of sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
          await client.query(statement);
        }
      }
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'print_jobs'`);
      const names = new Set(columns.rows.map((row: { column_name: string }) => row.column_name));
      for (const required of ["destination", "agent_id", "printer_id", "idempotency_key", "delivery_attempts"]) {
        if (!names.has(required)) throw new Error(`test database is missing print_jobs.${required}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally { client.release(); }
}
export async function applyMigrations(): Promise<void> {
  if (!migrationPromise) migrationPromise = applyMigrationsOnce().catch((error) => { migrationPromise = null; throw error; });
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
      for (const table of ["agents", "api_keys", "auth_rate_limits", "discovered_devices", "discovery_sessions", "manager_sessions", "printers", "print_jobs", "print_job_rate_limits", "tenant_domains", "applications", "tenant_users", "users", "tenants"]) {
        try { await client.query(`TRUNCATE TABLE ${quoteIdent(table)} RESTART IDENTITY CASCADE`); } catch (error: any) { if (error?.code !== "42P01") throw error; }
      }
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
}
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export type Fixture = { tenantId: string; agentId: string; agentSecret: string; agentAuth: string; printerId: string; destination: string; odooKey: string };

export async function seedFixture(opts?: { printerCapabilities?: unknown }): Promise<Fixture> {
  const suffix = randomBytes(8).toString("hex");
  const agentId = `agt_${suffix}`;
  const agentSecret = randomBytes(16).toString("base64url");
  const printerId = `printer_${suffix}`;
  const destination = `POS ${suffix}`;
  const odooKey = `odoo_${randomBytes(18).toString("base64url")}`;
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      const tenantId = `tenant_${suffix}`;
      await client.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `Tenant ${suffix}`]);
      await client.query(`INSERT INTO agents (id, tenant_id, name, secret, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, $4, 'online', 'active', now())`, [agentId, tenantId, `Agent ${suffix}`, sha256(agentSecret)]);
      await client.query(`INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities) VALUES ($1, $2, $3, $4, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $5::jsonb)`, [printerId, tenantId, agentId, `Printer ${suffix}`, JSON.stringify(opts?.printerCapabilities ?? { supported_protocols: ["raw", "escpos", "pdf", "image"] })]);
      await client.query(`INSERT INTO api_keys (id, tenant_id, scope, name, hashed_key) VALUES ($1, $2, 'standard', 'test key', $3)`, [`key_${suffix}`, tenantId, sha256(odooKey)]);
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
  return { tenantId: `tenant_${suffix}`, agentId, agentSecret, agentAuth: `Bearer ${agentId}:${agentSecret}`, printerId, destination, odooKey };
}

export async function insertQueuedJob(f: Fixture, jobId: string, opts?: { expiresInMs?: number }): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      await client.query("BEGIN");
      await client.query(`INSERT INTO print_jobs (id, tenant_id, destination, document_type, agent_id, printer_id, status, payload, expires_at) VALUES ($1, $2, $3, 'receipt', $4, $5, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + ($6 || ' milliseconds')::interval)`, [jobId, f.tenantId, f.destination, f.agentId, f.printerId, String(opts?.expiresInMs ?? 3600_000)]);
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {} }
  } finally { client.release(); }
}
export async function jobRow(jobId: string): Promise<any> { return (await pool().query(`SELECT * FROM print_jobs WHERE id = $1`, [jobId])).rows[0]; }
export async function closePool(): Promise<void> { if (adminPool) { await adminPool.end(); adminPool = null; } }
