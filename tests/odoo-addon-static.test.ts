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
});
