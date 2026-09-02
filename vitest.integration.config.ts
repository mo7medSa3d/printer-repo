import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: [
      "tests/architecture-pg.test.ts",
      "tests/odoo-sync-transaction.test.ts",
      "tests/routing-availability.test.ts",
      "tests/print-idempotency.test.ts",
      "tests/e2e-job-flow.test.ts",
      "tests/ws-claim-delivery.test.ts",
      "tests/job-status-postgres-concurrency.test.ts",
      "tests/auth-rate-limit.test.ts",
      "tests/heartbeat-enabled.test.ts",
      "tests/health.test.ts",
    ],
    pool: "forks",
    // @ts-expect-error vitest 4 types still use poolOptions.forks.singleFork
    poolOptions: { forks: { singleFork: true } } as any,
    sequence: { concurrent: false, concurrentSnapshot: false },
    maxConcurrency: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
