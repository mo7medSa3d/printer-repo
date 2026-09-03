/**
 * Deterministic per-worker PostgreSQL schema for integration tests.
 *
 * Each Vitest worker (fork) gets its own isolated schema so that
 * TRUNCATE / INSERT / SELECT in one worker never observes or deletes
 * another worker's fixture. The schema is selected via the PostgreSQL
 * `search_path` connection option, which is set on every *new* connection
 * from the pool — making it connection-safe unlike `SET search_path` on a
 * single pooled connection.
 *
 * Production (no Vitest, no DATABASE_URL for tests) returns null → public.
 */
export function getWorkerSchema(): string | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  // Only use per-worker schemas when running under Vitest integration.
  // Vitest sets VITEST=true and VITEST_WORKER_ID / VITEST_POOL_ID per fork.
  // When running `npm run test:unit` without DB, hasTestDatabase is false and
  // we never create a pool, so returning null is fine.
  const isVitest = process.env.VITEST === "true" || !!process.env.VITEST_WORKER_ID || !!process.env.VITEST_POOL_ID;
  // In CI, `npm run test:integration` always has DATABASE_URL set and isVitest true.
  if (!isVitest) {
    // Fallback for `npm test` that runs all tests in one process without worker ID —
    // still isolate if we're in a test run with DATABASE_URL but no worker ID:
    // use a single shared test schema to avoid polluting public.
    // However, to keep production untouched, return null for non-Vitest runs.
    return null;
  }

  const raw =
    process.env.VITEST_WORKER_ID ||
    process.env.VITEST_POOL_ID ||
    `pid_${process.pid}`;

  // Sanitize to valid identifier: lowercase, alphanumeric + underscore, max 40 chars
  const safe = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  // Prefix to avoid collision with public tables; also ensures it starts with letter
  return `test_${safe}`;
}

export function schemaSearchPath(schema: string | null): string | null {
  if (!schema) return null;
  // Always include public as fallback for extensions (pgcrypto, etc.)
  return `${schema},public`;
}
