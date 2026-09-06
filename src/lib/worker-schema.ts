/**
 * Deterministic PostgreSQL schema used by integration tests.
 *
 * Vitest workers get an isolated schema. Spawned Gateway processes do not
 * inherit Vitest's worker variables, so TEST_WORKER_SCHEMA is an explicit
 * hand-off mechanism for those production-like child processes.
 *
 * Production returns null → public.
 */
export function getWorkerSchema(): string | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  // Explicitly supplied by integration tests when they spawn a production-like
  // Gateway process. This must only be used in test environments.
  const forced = process.env.TEST_WORKER_SCHEMA?.trim();
  if (forced) {
    if (!/^test_[a-z0-9_]+$/i.test(forced) || forced.length > 63) {
      throw new Error("Invalid TEST_WORKER_SCHEMA");
    }
    return forced;
  }

  // Only use per-worker schemas when running under Vitest integration.
  const isVitest =
    process.env.VITEST === "true" ||
    !!process.env.VITEST_WORKER_ID ||
    !!process.env.VITEST_POOL_ID;

  if (!isVitest) return null;

  const worker = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || "single";
  const raw = `${worker}_pid_${process.pid}`;
  const safe = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);

  return `test_${safe}`;
}

export function schemaSearchPath(schema: string | null): string | null {
  if (!schema) return null;
  return `${schema},public`;
}
