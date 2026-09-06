import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasBodyOverLimit } from "../src/lib/request-limits";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("production hardening contracts", () => {
  it("rejects declared request bodies over the endpoint limit", () => {
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "1024" } }), 2048)).toBe(false);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "2049" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test", { headers: { "content-length": "-1" } }), 2048)).toBe(true);
    expect(hasBodyOverLimit(new Request("http://test"), 2048)).toBe(false);
  });

  it("keeps the API body guard stream-safe (declared size via header only, chunked via buffered clone)", () => {
    // Regression guard for the P0 that 500'd every mutating /api/* request:
    // the old implementation attached a "data" listener to the ORIGINAL
    // request and passed that same disturbed stream to Next.js.
    const server = read("server.ts");
    const guard = read("src/server/request-guard.ts");
    expect(server).toContain("guardApiRequest(req, res)");
    expect(server).not.toContain('req.on("data"');
    expect(guard).toContain("export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;");
    expect(guard).toContain('const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];');
    expect(guard).toContain("REQUEST_BODY_TOO_LARGE");
    expect(guard).toContain("function cloneRequestWithBody(source: IncomingMessage, body: Buffer)");
    expect(guard).toContain('new IncomingMessage(source.socket)');
  });

  it("runs a real-HTTP regression test for the body guard", () => {
    // The guard must be exercised over real TCP (unit suite), and the built
    // server must be exercised by the Next.js acceptance test.
    expect(read("tests/request-guard-http.test.ts")).toContain("createServer");
    expect(read("tests/server-http-acceptance.test.ts")).toContain("getRequestHandler");
  });

  it("keeps the bundled Caddy sanitizing forwarded-IP headers and capping request bodies", () => {
    // The gateway's IP-scoped rate limiting (TRUST_PROXY=1) is only safe
    // when the proxy OVERWRITES X-Forwarded-For with the real client
    // address — appending (Caddy's default) would let clients spoof their
    // IP and bypass every IP limit.
    const caddy = read("Caddyfile");
    expect(caddy).toContain("header_up X-Forwarded-For {http.request.remote.host}");
    expect(caddy).toContain("header_up -X-Real-Ip");
    expect(caddy).toContain("max_size 8MiB");
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
    expect(compose).toContain("PGHOST: postgres");
    expect(compose).toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("DATABASE_URL: postgresql://");
    expect(read("src/db/index.ts")).toContain("PGPASSWORD");
    expect(read("scripts/db-migrate.ts")).toContain("hasDatabaseSettings");
  });

  it("keeps Drizzle journal entries unique and aligned with migration files", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("0012_runtime_state_checks");
    expect(tags).toContain("0013_runtime_state_constraint_scope_fix");
    expect(tags).toContain("0014_discovery_state_checks");
    expect(tags).toContain("0015_metrics_and_agent_notifications");
    expect(tags).toContain("0016_print_job_rate_limits");
    expect(tags).toContain("0017_notify_requeued_jobs");
    expect(read("drizzle/0013_runtime_state_constraint_scope_fix.sql")).toContain("current_schema()");
    expect(read("drizzle/0014_discovery_state_checks.sql")).toContain("discovered_devices_candidate_status_check");
  });

  it("does not silently restore the old auto-provision discovery path", () => {
    const provision = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route.ts");
    const verify = read("src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts");
    expect(provision).toContain('code: "DEVICE_NOT_APPROVED"');
    expect(provision).toContain('row.verification !== "verified"');
    expect(provision).toContain("UNSUPPORTED_DISCOVERY_TRANSPORT");
    expect(provision).not.toContain('wsd: "raw"');
    expect(provision).not.toContain('mdns: "ipp"');
    expect(provision).not.toContain('snmp: "raw"');
    expect(provision).not.toContain('usb: "raw"');
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

  it("keeps the main governance workflow present and explicit about the external protection prerequisite", () => {
    const workflow = read(".github/workflows/main-governance.yml");
    expect(workflow).toContain("Require protected main branch");
    expect(workflow).toContain("Configure GitHub branch protection or a ruleset");
    expect(workflow).not.toContain("blocks PR merges");
  });
});
