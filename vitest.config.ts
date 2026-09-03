import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    // The default suite also executes PostgreSQL-backed tests. Keep its
    // timeout aligned with the dedicated integration config so normal DB
    // contention does not turn a valid concurrency test into a false failure.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
