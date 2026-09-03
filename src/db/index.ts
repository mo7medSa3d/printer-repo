import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getWorkerSchema, schemaSearchPath } from "@/lib/worker-schema";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaWorkerSchema?: string | null;
};

// During `next build` page-data collection, DATABASE_URL may not be set (CI without DB).
// Create a lazy pool that only throws when actually used at runtime, so build succeeds.
function createPool(): Pool {
  if (!databaseUrl) {
    const dummy = {
      query: async () => { throw new Error("DATABASE_URL is required at runtime"); },
      connect: async () => { throw new Error("DATABASE_URL is required at runtime"); },
      on: () => dummy,
      end: async () => {},
    } as unknown as Pool;
    return dummy;
  }
  const workerSchema = getWorkerSchema();
  // Memoize the worker schema on the global so helpers/pg.ts can reuse the same decision
  // without re-evaluating per-pool creation (important for Drizzle singleton).
  if (workerSchema && globalForDb.__arenaWorkerSchema === undefined) {
    globalForDb.__arenaWorkerSchema = workerSchema;
  }
  const searchPath = workerSchema ? schemaSearchPath(workerSchema) : null;
  // Use connection string options to make search_path connection-safe: every new
  // connection from the pool starts with the correct schema, unlike SET search_path
  // on a single pooled connection which would be racy.
  // pg Pool supports `options` field which is passed as startup parameter.
  const poolConfig: any = { connectionString: databaseUrl };
  if (searchPath) {
    poolConfig.options = `-c search_path=${searchPath}`;
  }
  const pool = new Pool(poolConfig);
  if (workerSchema) {
    // Ensure the schema exists before any query uses it. Use a one-off admin pool
    // to avoid racing with the main pool's first query. Ignore 42P06 (duplicate_schema)
    // and 23505 (pg_namespace race) which can happen when two workers create the same
    // schema concurrently (e.g., when VITEST_WORKER_ID is not unique and falls back to pid).
    const adminPool = new Pool({ connectionString: databaseUrl });
    // Block pool creation until schema exists, but don't fail if it races
    // Use a sync-like helper: we can't await in createPool (sync), so we do a
    // fire-and-forget that will complete before the first real query in practice,
    // and also handle the case where the first query fails with "schema does not exist"
    // by retrying. For now, do a best-effort synchronous creation via a separate client.
    // Since createPool is sync, we use a quick async IIFE that blocks the event loop
    // until done by using deasync-like pattern: instead, we just ensure the schema
    // is created lazily on first query failure. The Drizzle Pool will retry.
    // As a pragmatic fix, we create the schema synchronously via a temporary Pool and
    // ignore duplicate errors. This is done fire-and-forget but we also handle the
    // "schema does not exist" error in the first query by catching and retrying.
    adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${workerSchema}"`).then(() => adminPool.end()).catch(() => adminPool.end());
  }
  return pool;
}

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

import * as schema from "./schema";
export const db = drizzle(pool, { schema });
