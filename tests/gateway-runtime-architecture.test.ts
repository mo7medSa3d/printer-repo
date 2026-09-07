import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".next", "target"].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs|xml|py|yml|yaml|json)$/.test(name)) out.push(full);
  }
  return out;
}

const activeSource = sourceFiles(join(root, "src"));
const odooSource = sourceFiles(join(root, "odoo_addons", "print_gateway")).filter((file) => !file.includes(join("odoo_addons", "print_gateway", "tests")));
const odooProductionFiles = odooSource.filter((file) => !file.includes("/tests/"));
function readAll(files: string[]): string { return files.map((file) => `${relative(root, file)}\n${readFileSync(file, "utf8")}`).join("\n"); }

describe("gateway runtime ownership contract", () => {
  it("has no Gateway business-entity ownership in active TypeScript", () => {
    const source = readAll(activeSource);
    for (const token of [
      "db.query.branches", "db.query.destinations", "db.query.documentTypes", "db.query.printerBindings",
      "pgTable(\"branches\"", "pgTable(\"destinations\"", "pgTable(\"document_types\"", "pgTable(\"printer_bindings\"",
      "gateway_branch_id", "/api/odoo/sync", "normalizeLegacyPrinterInput", "destinationId",
    ]) expect(source).not.toContain(token);
  });

  it("does not expose the removed Gateway branch or business-sync APIs", () => {
    expect(existsSync(join(root, "src/app/api/branches"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/odoo/sync"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/odoo/agents"))).toBe(false);
  });

  it("keeps print submission free of branch or destination entity IDs", () => {
    const route = readFileSync(join(root, "src/app/api/print/jobs/route.ts"), "utf8");
    expect(route).not.toMatch(/branchId|branch_id|destinationId|documentTypeId/);
    expect(route).toContain("printerId");
    expect(route).toContain("idempotencyKey");
  });

  it("exposes only a sanitized runtime-printer discovery endpoint for Odoo", () => {
    const route = readFileSync(join(root, "src/app/api/odoo/printers/route.ts"), "utf8");
    expect(route).toContain("validateOdooKey");
    expect(route).toContain("Cache-Control");
    expect(route).not.toContain("branchId");
    expect(route).not.toContain("create");
    expect(route).not.toContain("secret");
  });

  it("keeps Gateway-enabled report printing fail-closed", () => {
    const report = readFileSync(join(root, "odoo_addons/print_gateway/models/ir_actions_report.py"), "utf8");
    expect(report).toContain("route_report");
    expect(report).toContain("super().report_action");
    expect(report).not.toContain("async_report");
  });

  it("intercepts the verified direct POS report endpoint", () => {
    const controller = readFileSync(join(root, "odoo_addons/print_gateway/controllers/pos.py"), "utf8");
    expect(controller).toContain("/pos/sale_details_report");
    expect(controller).toContain("route_render_target");
    expect(controller).toContain("if not gateway");
  });

  it("never invokes native POS receipt printing from the Gateway-enabled branch", () => {
    const source = readFileSync(join(root, "odoo_addons/print_gateway/static/src/js/pos_print_router.js"), "utf8");
    const gatewayBlock = source.split("if (result?.gateway_enabled)", 2)[1]?.split("if (result?.native)", 2)[0] ?? "";
    expect(gatewayBlock).not.toContain("super.printReceipt");
    expect(gatewayBlock).not.toContain("window.print");
    expect(source).toContain("is_gateway_printing_enabled");
    expect(source).toContain("syncAllOrders");
  });

  it("blocks native POS order-preparation printing while Gateway mode is enabled", () => {
    const source = readFileSync(join(root, "odoo_addons/print_gateway/static/src/js/pos_print_router.js"), "utf8");
    const kitchenBlock = source.split("async printChanges(...args)", 2)[1]?.split("return super.printChanges", 2)[0] ?? "";
    expect(kitchenBlock).toContain("is_gateway_printing_enabled");
    expect(kitchenBlock).toContain("throw error");
  });

  it("contains no native browser-print fallback in addon production source", () => {
    const source = readAll(odooProductionFiles);
    expect(source).not.toContain("window.print");
    expect(source).not.toMatch(/webPrintFallback/);
  });

  it("keeps only the final Odoo integration model files", () => {
    const modelsDir = join(root, "odoo_addons/print_gateway/models");
    expect(readdirSync(modelsDir).filter((name) => name.endsWith(".py")).sort()).toEqual([
      "__init__.py", "binding.py", "gateway_config.py", "ir_actions_report.py", "pos_order.py", "print_job.py", "print_router.py",
    ]);
  });

  it("contains no legacy ownership terms in the addon production source", () => {
    const source = readAll(odooProductionFiles);
    for (const token of ["gateway_branch_id", "branch_sync", "report_mapping", "async_report", "destination_id", "document_type_id"]) {
      expect(source).not.toContain(token);
    }
  });
});
