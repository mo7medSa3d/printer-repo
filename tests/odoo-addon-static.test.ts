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
    expect(src).toContain("uuid.uuid4().hex");
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

  it("models printer ownership as Branch -> Agent -> Printer", () => {
    const printer = readFileSync(path.join(ADDON, "models/printer.py"), "utf8");
    // The printer's owner is the agent …
    expect(printer).toContain("agent_id = fields.Many2one(");
    expect(printer).toContain("'print_gateway.agent'");
    // … and its branch is a stored RELATED field on the agent, never an
    // independently writable source of truth.
    expect(printer).toContain("related='agent_id.branch_id'");
    expect(printer).toContain("readonly=True");
    // Global uniqueness: one physical printer cannot be mirrored into two branches.
    expect(printer).toContain("unique(gateway_printer_id)");
    expect(printer).not.toContain("unique(gateway_printer_id, branch_id)");

    const agent = readFileSync(path.join(ADDON, "models/agent.py"), "utf8");
    expect(agent).toContain("branch_id = fields.Many2one(");
    // A real one2many on the ownership column, not a computed Char search.
    expect(agent).toContain("fields.One2many('print_gateway.printer', 'agent_id'");
    expect(agent).not.toContain("_compute_printers");
    expect(agent).toContain("unique(gateway_agent_id)");
  });

  it("validates binding branch through printer -> agent, not through a printer branch column", () => {
    const binding = readFileSync(path.join(ADDON, "models/printer_binding.py"), "utf8");
    expect(binding).toContain("rec.printer_id.agent_id.branch_id");
    expect(binding).toContain("Cross-branch binding refused");
    // The old check read the printer's own branch field directly.
    expect(binding).not.toContain("rec.printer_id.branch_id != rec.branch_id");
  });

  it("syncs agents before printers and never duplicates a reassigned record", () => {
    const branch = readFileSync(path.join(ADDON, "models/branch.py"), "utf8");
    const syncFn = branch.indexOf("def action_sync_from_gateway");
    const body = branch.slice(syncFn, branch.indexOf("def action_sync_to_gateway"));
    // Agents must be fetched first: a printer cannot exist without its agent.
    expect(body.indexOf("/api/odoo/agents")).toBeLessThan(body.indexOf("/api/odoo/printers"));
    // Matching is by GLOBAL gateway id, so a reassigned agent/printer is MOVED.
    expect(body).toContain("Agent.search([('gateway_agent_id', '=', gw_agent_id)], limit=1)");
    expect(body).toContain("Printer.search([('gateway_printer_id', '=', gw_printer_id)], limit=1)");
    // The printer is written with its agent, never with a branch.
    expect(body).toContain("'agent_id': agent.id,");
    expect(body).not.toContain("'branch_id': branch.id,\n                            'gateway_printer_id'");
    // Stale mirrors are disabled, never deleted.
    expect(body).toContain("'status': 'offline', 'enabled': False");
  });

  it("ships a fail-loud Odoo migration for existing installs", () => {
    const mig = readFileSync(path.join(ADDON, "migrations/1.1.0/pre-migrate.py"), "utf8");
    expect(mig).toContain("disagree with their agent about");
    expect(mig).toContain("Refusing to");
    expect(mig).toContain("cannot be attached to an agent");
    const manifest = readFileSync(path.join(ADDON, "__manifest__.py"), "utf8");
    expect(manifest).toContain("'version': '1.1.0'");
  });

  it("does not use (model + record_ids + report_id + current_minute) as identity", () => {
    const report = readFileSync(path.join(ADDON, "models/ir_actions_report.py"), "utf8");
    expect(report).not.toContain("current_minute");
    expect(report).toContain("idempotency_key = _uuid.uuid4().hex");
  });
});
