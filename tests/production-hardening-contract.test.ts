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

  it("fences agent-driven expiration at the database clock", () => {
    const route = read("src/app/api/agent/jobs/route.ts");
    const jobStatus = read("src/lib/job-status.ts");
    expect(jobStatus).toContain('claimed: new Set(["printing", "failed", "queued"])');
    expect(jobStatus).toContain('printing: new Set(["success", "failed"])');
    expect(route).toContain('if (requestedStatus !== "expired" && job.claimToken && claimToken !== job.claimToken)');
    expect(route).toContain('requestedStatus === "expired"');
    expect(route).toContain('fencedJobWrite(jobId, agent.id, currentStatus, claimToken)');
    expect(route).toContain('sql`${printJobs.expiresAt} <= now()`');
    expect(route).toContain('code: "JOB_NOT_EXPIRED_OR_STALE"');
    expect(route).toContain('JOB_EXPIRED_DURING_PRINT: physical output is unknown');
    expect(route).toContain('UNKNOWN_PARTIAL_DELIVERY: job expired after delivery without an execution report');
  });

  it("keeps the API body guard stream-safe without request cloning", () => {
    const server = read("server.ts");
    const guard = read("src/server/request-guard.ts");
    expect(server).toContain("guardApiRequest(req, res)");
    expect(server).not.toContain('req.on("data"');
    expect(guard).toContain("export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;");
    expect(guard).toContain('const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];');
    expect(guard).toContain("REQUEST_BODY_TOO_LARGE");
    expect(guard).toContain("MAX_CONCURRENT_CHUNKED_BYTES");
    expect(guard).not.toContain("cloneRequestWithBody");
    expect(guard).not.toContain("new IncomingMessage");
    expect(guard).toContain("CONTENT_LENGTH_REQUIRED");
  });

  it("keeps the bundled Caddy sanitizing forwarded-IP headers and capping request bodies", () => {
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
    expect(compose).toContain("PGPASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).not.toContain("PGPASSWORD: ${POSTGRES_PASSWORD");
    expect(compose).not.toContain("DATABASE_URL: postgresql://");
    expect(read("src/db/index.ts")).toContain("runtimeSecret(\"PGPASSWORD\")");
    expect(read("src/lib/runtime-secret.ts")).toContain("${name}_FILE");
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
    expect(tags).toContain("0021_scope_print_jobs_to_api_key");
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

  it("keeps the dashboard focused on runtime agents, printers, and jobs", () => {
    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain("Runtime Printers");
    expect(dashboard).toContain("Recent Print Jobs");
    expect(dashboard).not.toContain("candidateStatus");
    expect(dashboard).not.toContain("Technical confidence remains unchanged");
  });

  it("keeps tenant scoping fail-closed in manager dashboard and agent lifecycle routes", () => {
    const dashboard = read("src/app/dashboard/page.tsx");
    const lifecycle = read("src/app/api/agents/[id]/route.ts");
    const helper = read("src/lib/agent-lifecycle.ts");
    expect(dashboard).toContain("eq(agents.tenantId, claims.tenantId)");
    expect(dashboard).toContain("eq(printers.tenantId, claims.tenantId)");
    expect(dashboard).toContain("eq(printJobs.tenantId, claims.tenantId)");
    expect(lifecycle).toContain("transitionAgentLifecycle(id, lifecycle, claims.tenantId)");
    expect(helper).toContain("eq(agents.tenantId, tenantId)");
    expect(helper).toContain("eq(printers.tenantId, tenantId)");
  });

  it("keeps stock validation print-policy fan-out intact", () => {
    const stock = read("odoo_addons/print_gateway/models/stock_picking.py");
    expect(stock).toContain("Multi-destination fan-out");
    expect(stock).toContain("executed_targets = set()");
    expect(stock).toContain("intent_model.create_and_route(policy, picking, \"picking_validated\")");
    expect(stock).not.toMatch(/create_and_route\(policy, picking, [^\n]+\n\s*break/);
  });

  it("keeps direct print submission printer-scoped and payload-validated", () => {
    const route = read("src/app/api/print/jobs/route.ts");
    expect(route).toContain("validatePrintJobPayload(parsed.data.payload)");
    expect(route).toContain("printerId");
    expect(route).not.toContain("branchId");
    expect(route).not.toContain("branch_id");
    expect(route).not.toContain("destinationId");
  });

  it("keeps the main governance workflow present and explicit about the external protection prerequisite", () => {
    const workflow = read(".github/workflows/main-governance.yml");
    expect(workflow).toContain("Require protected main branch");
    expect(workflow).toContain("Configure GitHub branch protection or a ruleset");
    expect(workflow).toContain("security-audit");
    expect(workflow).toContain("exit 1");
  });
});
