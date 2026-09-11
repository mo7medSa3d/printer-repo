import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: [
      "tests/architecture-pg.test.ts",
      "tests/routing-availability.test.ts",
      "tests/print-idempotency.test.ts",
      "tests/e2e-job-flow.test.ts",
      "tests/ws-claim-delivery.test.ts",
      "tests/ws-listener-setup-race.test.ts",
      "tests/ws-socket-cap.test.ts",
      "tests/batch-status.test.ts",
      "tests/job-status-postgres-concurrency.test.ts",
      "tests/auth-rate-limit.test.ts",
      "tests/heartbeat-enabled.test.ts",
      "tests/health.test.ts",
      "tests/agent-registration.test.ts",
      "tests/migration-upgrade.integration.test.ts",
      "tests/multi-instance-gateway.test.ts",
      "tests/ci-tripwire.check.ts",
    ],
    pool: "forks",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
