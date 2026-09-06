/**
 * Deterministic PostgreSQL schema used by integration tests.
 *
 * Vitest workers get an isolated schema. Spawned Gateway processes do not
 * inherit Vitest's worker variables, so TEST_WORKER_SCHEMA is an explicit
 * hand-off mechanism for the multi-instance integration test.
 *
 * Production returns null → public.
 */
export function getWorkerSchema(): string | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  // Only the multi-instance integration test may explicitly hand a worker
  // schema to a spawned production-like Gateway. Never let an arbitrary
  // production environment silently redirect normal traffic to another
  // PostgreSQL schema.
  const forced = process.env.TEST_WORKER_SCHEMA?.trim();
  const forcedTestRun = process.env.RUN_MULTI_INSTANCE_TEST === "1" && process.env.CI === "true";
  if (forced && forcedTestRun) {
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
