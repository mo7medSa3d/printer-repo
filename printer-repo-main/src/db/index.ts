import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

// During `next build` page-data collection, DATABASE_URL may not be set (CI without DB).
// Create a lazy pool that only throws when actually used at runtime, so build succeeds.
function createPool(): Pool {
  if (!databaseUrl) {
    // dummy pool that throws on query; build can still collect static metadata
    const dummy = {
      query: async () => { throw new Error("DATABASE_URL is required at runtime"); },
      connect: async () => { throw new Error("DATABASE_URL is required at runtime"); },
      on: () => dummy,
      end: async () => {},
    } as unknown as Pool;
    return dummy;
  }
  return new Pool({ connectionString: databaseUrl });
}

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

import * as schema from "./schema";
export const db = drizzle(pool, { schema });
