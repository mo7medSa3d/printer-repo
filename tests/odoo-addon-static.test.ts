import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDON = path.join(ROOT, "odoo_addons", "print_gateway");
const read = (file: string) => readFileSync(path.join(ADDON, file), "utf8");

describe("Odoo addon static contracts", () => {
  it("discovers every test module from tests/__init__.py", () => {
    const testsInit = read("tests/__init__.py");
    expect(testsInit).toMatch(/from\s+\.\s+import\s+\w+/);
  });

  it("routes backend reports through the central router and stays native only when Gateway is disabled", () => {
    const src = read("models/ir_actions_report.py");
    expect(src).toContain("def report_action");
    expect(src).toContain("router = self.env[\"print_gateway.print_router\"]");
    expect(src).toContain("route = router.route_report");
    expect(src).toContain('if not route.get("native")');
    expect(src).toContain("super().report_action");
    expect(src).not.toContain("async_report");
  });

  it("persists the durable outbox row before the Gateway HTTP submission", () => {
    const router = read("models/print_router.py");
    const persist = router.indexOf("def _persist_durable_job");
    const create = router.indexOf("create_operation", persist);
    const commit = router.indexOf("cr.commit()", persist);
    const submit = router.indexOf("job.action_submit", persist);
    expect(persist).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(persist);
    expect(commit).toBeGreaterThan(create);
    expect(submit).toBeGreaterThan(commit);
    expect(router).toContain("idempotency_key");
  });

  it("keeps Odoo submission idempotent and marks transport ambiguity as unknown outcome", () => {
    const jobs = read("models/print_job.py");
    expect(jobs).toContain("UNIQUE(company_id, idempotency_key)");
    expect(jobs).toContain("idempotency_key");
    expect(jobs).toContain("UNKNOWN_SUBMISSION_OUTCOME");
    expect(jobs).toContain('status": "unknown"');
    expect(jobs).toContain("def action_submit");
    expect(jobs).toContain("def action_sync_status");
  });

  it("keeps bindings Odoo-native and resolves runtime printers without Gateway business ownership", () => {
    const binding = read("models/binding.py");
    expect(binding).toContain("destination_pos_config_id");
    expect(binding).toContain("destination_pos_printer_id");
    expect(binding).toContain("destination_picking_type_id");
    expect(binding).toContain("destination_report_id");
    expect(binding).toContain("def find_for");
    expect(binding).toContain('("company_id", "=", company.id)');
    expect(binding).toContain('("enabled", "=", True)');
    expect(binding).toContain('("destination_ref", "=",');
  });

  it("validates runtime printer ownership at the Odoo binding boundary", () => {
    const binding = read("models/binding.py");
    const router = read("models/print_router.py");
    expect(binding).toContain("A Gateway Runtime Printer must be selected.");
    expect(binding).toContain("Odoo Destination belongs to another company/branch context.");
    expect(router).toContain("The selected records resolve to different Print Bindings");
    expect(router).toContain("printer_id");
  });

  it("keeps POS receipt, Kitchen, and Sale Details paths fail-closed under Gateway mode", () => {
    const order = read("models/pos_order.py");
    const session = read("models/pos_session.py");
    const posController = read("controllers/pos.py");
    expect(order).toContain("action_print_gateway_receipt");
    expect(order).toContain("action_print_gateway_kitchen");
    expect(order).toContain("is_gateway_printing_enabled");
    expect(session).toContain("action_print_gateway_sale_details");
    expect(posController).toContain("/pos/sale_details_report");
    expect(posController).toContain("if not gateway");
    expect(posController).toContain("route_render_target");
  });

  it("keeps payload representations canonical and bounded", () => {
    const router = read("models/print_router.py");
    const jobs = read("models/print_job.py");
    expect(router).toContain('"type": "pdf"');
    expect(router).toContain('"type": "image"');
    expect(router).toContain("_validate_pdf");
    expect(router).toContain("_validate_jpeg_base64");
    expect(router).toContain("MAX_IMAGE_BYTES = 5 * 1024 * 1024");
    expect(jobs).toContain('"printerId": self.printer_id');
    expect(jobs).toContain('"documentType": self.document_type');
    expect(jobs).toContain('"idempotencyKey": self.idempotency_key');
    expect(jobs).not.toContain("pcl");
  });

  it("enforces root-company invariant and fail-closed report interceptor", () => {
    const binding = read("models/binding.py");
    const interceptor = read("static/src/js/report_interceptor.js");

    // Invariant: Company must be root and branch must belong to company
    expect(binding).toContain('@api.constrains("company_id", "branch_id")');
    expect(binding).toContain("def _check_company_hierarchy");
    expect(binding).toContain("record.company_id.parent_id");
    expect(binding).toContain("Odoo Company must be a root Company, not a Branch.");

    // Fail-Closed: binding pre-resolution and interceptor handling
    expect(binding).toContain('"fail_closed": True');
    expect(binding).toContain('"has_binding": True');
    expect(interceptor).toContain("res.has_binding && (res.success === false || !res.dispatched)");
    expect(interceptor).toContain("return true; // FAIL-CLOSED");
    expect(interceptor).toContain("return false; // Fallback to standard Odoo report action only when no binding exists");
  });

  it("uses root-aware resolver for POS gateway enablement instead of direct config queries", () => {
    const order = read("models/pos_order.py");
    const session = read("models/pos_session.py");
    const posCtrl = read("controllers/pos.py");

    // Must NOT contain direct gateway_config searches by self.env.company.id
    for (const src of [order, session]) {
      expect(src).not.toContain('("company_id", "=", self.env.company.id)');
    }
    expect(posCtrl).not.toContain("('company_id', '=', request.env.company.id)");

    // Must use the router's root-aware resolver
    expect(order).toContain("_gateway_config");
    expect(session).toContain("_gateway_config");
    expect(posCtrl).toContain("_gateway_config");
  });

  it("persists outbox jobs under the active branch company, not the root gateway company", () => {
    const router = read("models/print_router.py");
    const submitIdx = router.indexOf("def _submit_route");
    const submitBlock = router.slice(submitIdx, submitIdx + 600);
    // The company passed to _persist_durable_job must be the caller's company, not route["company"]
    expect(submitBlock).toContain('"company": company');
    expect(submitBlock).not.toContain('"company": route["company"]');
  });

  it("validates gateway config ownership through company hierarchy, not strict equality", () => {
    const jobs = read("models/print_job.py");
    expect(jobs).toContain("expected_config_owner = company.parent_id or company");
    expect(jobs).toContain("gateway_config.company_id != expected_config_owner");
    expect(jobs).not.toContain("gateway_config.company_id != company");
  });

  it("secures gateway config and binding resolution for branch users using sudo in router and job", () => {
    const router = read("models/print_router.py");
    const jobs = read("models/print_job.py");
    const security = read("security/security.xml");

    expect(router).toContain('self.env["print_gateway.gateway_config"].sudo().search');
    expect(router).toContain('self.env["print_gateway.binding"].sudo().find_for');
    expect(jobs).toContain("job.gateway_config_id.sudo()");
    expect(security).toContain("('company_id.child_ids', 'in', company_ids)");
    expect(security).toContain("('branch_id', 'in', company_ids)");
  });

  it("decouples network I/O from @api.constrains in binding and provides action button", () => {
    const binding = read("models/binding.py");
    const views = read("views/binding_views.xml");

    const scopeIdx = binding.indexOf("def _check_runtime_scope");
    const bindingIdx = binding.indexOf("def _check_binding");
    const constraintBody = binding.slice(scopeIdx, bindingIdx);

    expect(constraintBody).not.toContain("_validate_runtime_target");
    expect(constraintBody).not.toContain("requests.");
    expect(binding).toContain("def action_verify_remote_hardware(self):");
    expect(views).toContain('name="action_verify_remote_hardware"');
  });

  it("hardens runtime printer controller against cross-branch IDOR with Forbidden", () => {
    const controller = read("controllers/runtime_printers.py");

    expect(controller).toContain("from werkzeug.exceptions import Forbidden");
    expect(controller).toContain("raise Forbidden");
    expect(controller).toContain('["print_gateway.gateway_config"].sudo().search');
  });
});

