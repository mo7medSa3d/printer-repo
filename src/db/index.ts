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
  const poolConfig: any = { connectionString: databaseUrl };
  if (searchPath) {
    poolConfig.options = `-c search_path=${searchPath}`;
  }
  const pool = new Pool(poolConfig);
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
