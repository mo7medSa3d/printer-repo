import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

const ADDON = "odoo_addons/print_gateway";

describe("Odoo addon static contracts", () => {
  it("discovers every test_*.py module from tests/__init__.py", () => {
    const init = readFileSync(path.join(ADDON, "tests/__init__.py"), "utf8");
    const files = readdirSync(path.join(ADDON, "tests")).filter((f) => f.startsWith("test_") && f.endsWith(".py"));
    expect(files).toEqual(expect.arrayContaining([
      "test_report_gateway.py",
      "test_routing_correctness.py",
      "test_security_regressions.py",
    ]));
    for (const file of files) {
      const mod = file.replace(/\.py$/, "");
      expect(init).toContain(`from . import ${mod}`);
    }
  });

  it("never routes a single-record report with a null branch", () => {
    const src = readFileSync(path.join(ADDON, "models/ir_actions_report.py"), "utf8");
    expect(src).not.toContain("'branch': None, 'destination': None");
    expect(src).toContain("Resolve routing for EVERY record");
  });

  it("persists the operation id before the Gateway HTTP call", () => {
    const src = readFileSync(path.join(ADDON, "models/branch.py"), "utf8");
    expect(src).toContain("idempotency_key");
    expect(src).toContain("persist the operation ID BEFORE");
    const createFn = src.indexOf("def create_print_job");
    expect(createFn).toBeGreaterThan(-1);
    expect(src.indexOf("Job.create", createFn)).toBeLessThan(src.indexOf("requests.post", createFn));
    expect(src).toContain("for attempt in (1, 2)");
    expect(src).toContain("idempotency_key = uuid.uuid4().hex");
    expect(src).toContain("with self.env.cr.savepoint()");
    const jobModel = readFileSync(path.join(ADDON, "models/print_job.py"), "utf8");
    expect(jobModel).toContain("unique(branch_id, idempotency_key)");
  });

  it("records per-branch sync failure instead of claiming distributed atomicity", () => {
    const src = readFileSync(path.join(ADDON, "models/branch.py"), "utf8");
    expect(src).toContain("last_sync_status");
    expect(src).toContain("last_sync_error");
    expect(src).toContain("There is no distributed transaction");
    expect(src).toContain("Sync partially failed");
  });

  it("requires an affirmative JSON success response for gateway push sync", () => {
    const src = readFileSync(path.join(ADDON, "models/branch.py"), "utf8");
    expect(src).toContain("Gateway returned malformed JSON for sync response");
    expect(src).toContain("result.get('success') is not True");
  });

  it("keeps printer branch derived from agent and terminal lifecycle enforced", () => {
    const printer = readFileSync(path.join(ADDON, "models/printer.py"), "utf8");
    const agent = readFileSync(path.join(ADDON, "models/agent.py"), "utf8");
    expect(printer).toContain("related='agent_id.branch_id'");
    expect(printer).toContain("Retired printers are terminal");
    expect(agent).toContain("Retired agents are terminal");
  });

  it("persists logical-operation identity and retries it after restart", () => {
    const report = readFileSync(path.join(ADDON, "models/ir_actions_report.py"), "utf8");
    const job = readFileSync(path.join(ADDON, "models/print_job.py"), "utf8");
    expect(report).not.toContain("current_minute");
    expect(report).toContain("idempotency_key = _uuid.uuid4().hex");
    expect(job).toContain("def action_submit_pending");
    expect(job).toContain("idempotency_key=job.idempotency_key");
    expect(job).toContain("json.loads(payload_raw)");
    expect(readFileSync(path.join(ADDON, "models/branch.py"), "utf8")).toContain("self.env.cr.postcommit.add(_submit_after_commit)");
  });

  it("syncs canonical payloadHint and removes unsupported PCL", () => {
    const branch = readFileSync(path.join(ADDON, "models/branch.py"), "utf8");
    const documentType = readFileSync(path.join(ADDON, "models/document_type.py"), "utf8");
    const printer = readFileSync(path.join(ADDON, "models/printer.py"), "utf8");
    expect(branch).toContain("'payloadHint': dt.payload_hint or False");
    expect(documentType).not.toContain("('pcl', 'PCL')");
    expect(printer).not.toContain("('pcl', 'PCL')");
  });
});
