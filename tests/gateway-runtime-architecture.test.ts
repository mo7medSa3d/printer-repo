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
const odooProductionFiles = odooSource.filter((file) => {
  const normalized = relative(root, file).split(/[\\/]+/).join("/");
  return !normalized.split("/").includes("tests") && !normalized.split("/").includes("migrations");
});
function readAll(files: string[]): string { return files.map((file) => `${relative(root, file)}\n${readFileSync(file, "utf8")}`).join("\n"); }

describe("gateway runtime ownership contract", () => {
  it("has no Gateway business-entity ownership in active TypeScript or schema", () => {
    const source = readAll(activeSource);
    const schema = readFileSync(join(root, "src/db/schema.ts"), "utf8");
    for (const token of [
      "db.query.branches", "db.query.destinations", "db.query.documentTypes", "db.query.printerBindings",
      "pgTable(\"branches\"", "pgTable(\"destinations\"", "pgTable(\"document_types\"", "pgTable(\"printer_bindings\"",
      "gateway_branch_id", "/api/odoo/sync", "normalizeLegacyPrinterInput", "destinationId",
    ]) expect(source).not.toContain(token);
    for (const token of [
      'pgTable("branches"', 'pgTable("destinations"', 'pgTable("document_types"', 'pgTable("printer_bindings"',
      'pgTable("odoo_companies"', 'pgTable("odoo_bindings"',
    ]) expect(schema).not.toContain(token);
    expect(schema).toContain('pgTable("agents"');
    expect(schema).toContain('pgTable("printers"');
  });

  it("does not expose removed Gateway branch or business-sync APIs while retaining runtime-agent discovery", () => {
    expect(existsSync(join(root, "src/app/api/branches"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/odoo/sync"))).toBe(false);
    expect(existsSync(join(root, "src/app/api/odoo/agents/route.ts"))).toBe(true);
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

  it("exposes authenticated runtime-agent discovery without Gateway business ownership", () => {
    const route = readFileSync(join(root, "src/app/api/odoo/agents/route.ts"), "utf8");
    expect(route).toContain("validateOdooKey");
    expect(route).toContain("agents");
    expect(route).toContain("Cache-Control");
    expect(route).not.toContain("branchId");
    expect(route).not.toContain("businessId");
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
    const nativeFallback = source.indexOf("if (gatewayEnabled !== true) {");
    expect(nativeFallback).toBeGreaterThanOrEqual(0);
    const nativeReturn = source.indexOf("return super.printReceipt", nativeFallback);
    const syncStart = source.indexOf("if (!currentOrder.isSynced)", nativeFallback);
    const gatewayBlockEnd = source.indexOf("    },", syncStart);
    const gatewayBlock = syncStart >= 0 ? source.slice(syncStart, gatewayBlockEnd >= 0 ? gatewayBlockEnd : source.length) : "";
    expect(nativeReturn).toBeGreaterThanOrEqual(nativeFallback);
    expect(gatewayBlock).not.toContain("super.printReceipt");
    expect(gatewayBlock).not.toContain("window.print");
    expect(source).toContain("is_gateway_printing_enabled");
    expect(source).toContain("syncAllOrders");
    expect(source).toContain("basic_receipt: Boolean(basic)");
    expect(source).toContain("action_print_gateway_receipt");
  });

  it("blocks native POS order-preparation printing while Gateway mode is enabled", () => {
    const source = readFileSync(join(root, "odoo_addons/print_gateway/static/src/js/pos_print_router.js"), "utf8");
    const methodStart = source.indexOf("async printOrderChanges(data, printer) {");
    const method = methodStart >= 0 ? source.slice(methodStart) : "";
    const gatewayGuard = method.indexOf("if (gatewayEnabled !== true) {");
    const gatewayCall = method.indexOf("action_print_gateway_kitchen");
    const fallbackCall = method.indexOf("return super.printOrderChanges");
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(gatewayGuard).toBeGreaterThanOrEqual(0);
    expect(gatewayCall).toBeGreaterThan(gatewayGuard);
    expect(fallbackCall).toBeGreaterThan(gatewayGuard);
    expect(fallbackCall).toBeLessThan(gatewayCall);
    expect(method.slice(gatewayCall)).not.toContain("return super.printOrderChanges");
    expect(method.slice(gatewayCall)).toContain("successful:");
  });

  it("contains no native browser-print fallback in addon production source", () => {
    const source = readAll(odooProductionFiles);
    expect(source).not.toContain("window.print");
    expect(source).not.toMatch(/webPrintFallback/);
  });

  it("keeps only the active Odoo integration model files", () => {
    const modelsDir = join(root, "odoo_addons/print_gateway/models");
    expect(readdirSync(modelsDir).filter((name) => name.endsWith(".py")).sort()).toEqual([
      "__init__.py", "account_move.py", "binding.py", "crypto.py", "gateway_config.py", "ir_actions_report.py", "pos_order.py", "pos_session.py", "print_intent.py", "print_job.py", "print_policy.py", "print_router.py", "runtime_assignment.py", "stock_picking.py",
    ]);
  });

  it("contains no legacy ownership terms in the active addon production source", () => {
    const source = readAll(odooProductionFiles);
    for (const token of ["gateway_branch_id", "branch_sync", "report_mapping", "async_report", "destination_id", "document_type_id"]) {
      expect(source).not.toContain(token);
    }
  });
});
