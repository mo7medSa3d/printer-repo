import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("printing crash recovery", () => {
  it("fails stale printing jobs without requiring delivery retries", () => {
    const src = readFileSync("src/app/api/agent/jobs/route.ts", "utf8");
    const start = src.indexOf("error = 'AGENT_EXECUTION_TIMEOUT'");
    const updateStart = src.lastIndexOf("UPDATE print_jobs", start);
    const end = src.indexOf("`);", start);
    const sqlBlock = src.slice(updateStart, end);

    expect(sqlBlock).toContain("status = 'printing'");
    expect(sqlBlock).toContain("status = 'failed'");
    expect(sqlBlock).toContain("AGENT_EXECUTION_TIMEOUT");
    expect(sqlBlock).not.toContain("retries >= ${MAX_RETRIES}");
  });

  it("uses the shared agent availability policy for all service-created jobs", () => {
    const src = readFileSync("src/lib/print-job-service.ts", "utf8");
    expect(src).toContain('from "@/lib/agent-availability"');
    expect(src).toContain("const availability = getAgentAvailability(ownerAgent);");
    expect(src).toContain("Agent is not available for jobs (reason=${availability.reason})");
  });
});
