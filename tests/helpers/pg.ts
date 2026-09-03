import { readFileSync, readdirSync } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";
import { getWorkerSchema, schemaSearchPath } from "@/lib/worker-schema";

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
    const config = {
      connectionString: TEST_DATABASE_URL,
      max: 8,
      ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
    };
    adminPool = new Pool(config);
  }
  return adminPool;
}

const GLOBAL_PG_LOCK = 727727;

async function applyMigrationsOnce(): Promise<void> {
  const schema = getOrCreateWorkerSchema();
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      // Worker schemas are disposable test state. Recreate only the isolated
      // worker schema so stale objects from a prior worker run can never make
      // migrations non-deterministic. Never drop public.
      if (schema) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
        await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
        await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      }

      await client.query("BEGIN");
      const dir = path.resolve(process.cwd(), "drizzle");
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const sqlText = readFileSync(path.join(dir, file), "utf8");
        const statements = sqlText
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean);

        for (const stmt of statements) {
          // A fresh worker schema must be migrated exactly once. Swallowing a
          // duplicate DDL error aborts the PostgreSQL transaction and only
          // turns the next statement into misleading 25P02 errors.
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

      // Prove the worker schema is self-contained before releasing it to tests.
      if (schema) {
        const fkCheck = await client.query(`
          SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid IN (
            to_regclass(${JSON.stringify(schema)} || '.agents'),
            to_regclass(${JSON.stringify(schema)} || '.printers'),
            to_regclass(${JSON.stringify(schema)} || '.print_jobs')
          )
          AND contype = 'f'
        `);
        for (const row of fkCheck.rows) {
          const definition = String(row.definition);
          if (definition.includes('public.')) {
            throw new Error(`worker schema FK escaped into public: ${row.conname} -> ${definition}`);
          }
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally {
    client.release();
  }
}

/** Apply migrations once per Vitest worker process. Failed attempts are retryable. */
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
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [GLOBAL_PG_LOCK]);
    try {
      await client.query("BEGIN");
      const schema = getOrCreateWorkerSchema();
      if (schema) await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
      const tables = [
        "agents",
        "api_keys",
        "auth_rate_limits",
         "branches",
        "destinations",
        "discovered_devices",
        "discovery_sessions",
        "document_types",
        "local_networks",
        "manager_sessions",
        "printer_bindings",
        "printers",
        "print_jobs",
      ];
      for (const table of tables) {
        try {
          await client.query(`TRUNCATE TABLE ${quoteIdent(table)} RESTART IDENTITY ONCAsCADE`);
        } catch (error: any) {
          if (error?.code !== "42P01") throw error;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      try { await client.query("SELECT pg_advisory_unlock($1)", [GLOBAL_PG_LOCK]); } catch {}
    }
  } finally {
    client.release();
  }
}
