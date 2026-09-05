import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBodyOverLimit } from "@/lib/request-limits";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("production hardening contracts", () => {
  it("rejects declared request bodies over the endpoint limit", () => {
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "1024" } }), 2048)).toBe(false);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "2049" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "-1" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test"), 2048)).toBe(false);
  });

  it("enforces a global pre-parser API body ceiling, including chunked requests", () => {
    const server = read("server.ts");
    expect(server).toContain("const MAX_API_BODY_BYTES = 8 * 1024 * 1024;");
    expect(server).toContain('if (!req.url?.startsWith("/api/")) return true;');
    expect(server).toContain('["POST", "PUT", "PATCH", "DELETE"]');
    expect(server).toContain("req.on(\"data\"");
    expect(server).toContain('"REQUEST_BODY_TOO_LARGE"');
  });

  it("keeps Docker migration out of runtime startup and orders Compose migration before gateway", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerfile).not.toContain("npm run db:migrate && npm start");
    expect(compose).toContain("migrate:");
    expect(compose).toContain('command: ["npm", "run", "db:migrate"]');
    expect(compose).toContain("service_completed_successfully");
    expect(compose).toContain("condition: service_healthy");
  });

  it("keeps Drizzle journal entries unique and aligned with migration files", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("0012_runtime_state_checks");
    expect(tags).toContain("0013_runtime_state_constraint_scope_fix");
    expect(tags).toContain("0014_discovery_state_checks");
    expect(read("drizzle/0013_runtime_state_constraint_scope_fix.sql")).toContain("current_schema()");
    expect(read("drizzle/0014_discovery_state_checks.sql")).toContain("discovered_devices_candidate_status_check");
  });

  it("does not silently restore the old auto-provision discovery path", () => {
    const provision = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts");
    const verify = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts");
    expect(provision).toContain('code: "DEVICE_NOT_APPROVED"');
    expect(provision).toContain('device.verification !== "verified"');
    expect(verify).toContain('verification: "verified"');
    expect(verify).toContain('candidateStatus: "verified"');
  });

  it("keeps dashboard approval aligned with technical confidence semantics", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain('candidateStatus: "verified", verification: "verified"');
    expect(dashboard).not.toContain('candidateStatus: "verified", verification: "verified", confidence: "high"');
    expect(dashboard).toContain("Technical confidence remains unchanged");
  });

  it("keeps the legacy direct-printer route branch-scoped and payload-validated", () => {
    const route = read("src/app/api/print/jobs/route.ts");
    expect(route).toContain("if (!odoo?.branchId)");
    expect(route).toContain("validatePrintJobPayload(parsed.payload)");
    expect(route).toContain("ownerAgent.branchId !== odoo.branchId");
  });
});
