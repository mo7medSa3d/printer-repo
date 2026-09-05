import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { getWorkerSchema, schemaSearchPath } from "../lib/worker-schema";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaWorkerSchema?: string | null;
};

// During `next build` page-data collection, no database settings may be present.
// Create a lazy pool that only throws when actually used at runtime, so builds
// can still complete without a configured database.
function createPool(): Pool {
  const hasStructuredConfig = Boolean(
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    process.env.PGPASSWORD,
  );

  if (!databaseUrl && !hasStructuredConfig) {
    const dummy = {
      query: async () => { throw new Error("PostgreSQL connection settings are required at runtime"); },
      connect: async () => { throw new Error("PostgreSQL connection settings are required at runtime"); },
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

  // Prefer an explicit connection string when supplied. Docker Compose uses
  // structured PG* variables instead, so passwords containing URI-reserved
  // characters such as `@`, `:` or `/` never need manual URL escaping.
  const poolConfig: PoolConfig = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT ?? "5432"),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
      };

  if (searchPath) {
    poolConfig.options = `-c search_path=${searchPath}`;
  }

  return new Pool(poolConfig);
}

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

import * as schema from "./schema";
export const db = drizzle(pool, { schema });
