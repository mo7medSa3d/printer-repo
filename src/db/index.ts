import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { getWorkerSchema, schemaSearchPath } from "../lib/worker-schema";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaWorkerSchema?: string | null;
};

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
  if (workerSchema && globalForDb.__arenaWorkerSchema === undefined) {
    globalForDb.__arenaWorkerSchema = workerSchema;
  }
  const searchPath = workerSchema ? schemaSearchPath(workerSchema) : null;

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

  poolConfig.max = 20;
  poolConfig.idleTimeoutMillis = 30_000;
  poolConfig.connectionTimeoutMillis = 10_000;
  poolConfig.statement_timeout = 30_000;
  poolConfig.lock_timeout = 5_000;
  poolConfig.maxUses = 10_000;

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
