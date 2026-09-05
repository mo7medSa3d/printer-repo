import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("printing crash recovery", () => {
  it("fails stale printing jobs without requiring delivery retries", () => {
    const src = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");
    const start = src.indexOf("const STALE_PRINTING_SECONDS = 10 * 60");
    const end = src.indexOf("// Reclaim only stale CLAIMED", start);
    const block = src.slice(start, end);

    expect(block).toContain("const STALE_PRINTING_SECONDS = 10 * 60");
    expect(block).toContain("status = 'printing'");
    expect(block).toContain("status = 'failed'");
    expect(block).toContain("AGENT_EXECUTION_TIMEOUT");
    expect(block).not.toContain("retries >= ${MAX_RETRIES}");
  });

  it("uses the shared agent availability policy for all service-created jobs", () => {
    const src = readFileSync("src/lib/print-job-service.ts", "utf8");
    expect(src).toContain('from "@/lib/agent-availability"');
    expect(src).toContain("const availability = getAgentAvailability(ownerAgent);");
    expect(src).toContain("Agent is not available for jobs (reason=${availability.reason})");
  });
});
