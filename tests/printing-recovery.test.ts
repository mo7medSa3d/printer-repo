import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("printing crash recovery", () => {
  it("fails stale printing jobs without requiring delivery retries", () => {
    const src = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");
    const timeoutIndex = src.indexOf("AGENT_EXECUTION_TIMEOUT");

    expect(src).toContain("const STALE_PRINTING_SECONDS = 10 * 60");
    expect(timeoutIndex).toBeGreaterThan(-1);

    const recoveryBlock = src.slice(Math.max(0, timeoutIndex - 1400), timeoutIndex + 500);
    expect(recoveryBlock).toContain("UPDATE print_jobs");
    expect(recoveryBlock).toContain("status = 'failed'");
    expect(recoveryBlock).toContain("status = 'printing'");
    expect(recoveryBlock).toContain(
      "updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})",
    );
    expect(recoveryBlock).not.toContain("AND retries >= ${MAX_RETRIES}");
  });

  it("uses the shared agent availability policy for all service-created jobs", () => {
    const src = readFileSync("src/lib/print-job-service.ts", "utf8");
    expect(src).toContain('from "@/lib/agent-availability"');
    expect(src).toContain("const availability = getAgentAvailability(ownerAgent);");
    expect(src).toContain("Agent is not available for jobs (reason=${availability.reason})");
  });
});
