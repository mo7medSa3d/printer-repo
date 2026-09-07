import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

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
const odooSource = sourceFiles(join(root, "odoo_addons", "print_gateway")).filter((file) => !file.includes(`${join("odoo_addons", "print_gateway", "tests")}`));

function readAll(files: string[]): string { return files.map((file) => `${relative(root, file)}\n${readFileSync(file, "utf8")}`).join("\n"); }

describe("gateway runtime ownership contract", () => {
  it("has no Gateway branch/destination/document-type ownership in active TypeScript", () => {
    const source = readAll(activeSource);
    const forbidden = [
      "db.query.branches", "db.query.destinations", "db.query.documentTypes", "db.query.printerBindings",
      "pgTable(\"branches\"", "pgTable(\"destinations\"", "pgTable(\"document_types\"", "pgTable(\"printer_bindings\"",
      "gateway_branch_id", "/api/odoo/sync", "normalizeLegacyPrinterInput",
    ];
    for (const token of forbidden) expect(source).not.toContain(token);
  });

  it("does not expose the removed Gateway branch API", () => {
    expect(existsSync(join(root, "src/app/api/branches"))).toBe(false);
  });

  it("keeps print submission contract free of branch fields", () => {
    const route = readFileSync(join(root, "src/app/api/print/jobs/route.ts"), "utf8");
    expect(route).not.toMatch(/branchId|branch_id|destinationId|documentTypeId/);
    expect(route).toContain("printerId");
    expect(route).toContain("idempotencyKey");
  });

  it("keeps Gateway-enabled report printing fail-closed", () => {
    const report = readFileSync(join(root, "odoo_addons/print_gateway/models/ir_actions_report.py"), "utf8");
    expect(report).toContain("if not gateway:");
    expect(report).toContain("route_report");
    expect(report).not.toContain("async_report");
  });

  it("never invokes native POS printing from the Gateway success branch", () => {
    const source = readFileSync(join(root, "odoo_addons/print_gateway/static/src/js/pos_print_router.js"), "utf8");
    const gatewayBlock = source.split("if (result?.gateway_enabled)", 2)[1]?.split("if (result?.native)", 2)[0] ?? "";
    expect(gatewayBlock).not.toContain("super.printReceipt");
    expect(gatewayBlock).not.toContain("window.print");
  });

  it("keeps only the three Odoo integration models", () => {
    const modelsDir = join(root, "odoo_addons/print_gateway/models");
    expect(readdirSync(modelsDir).filter((name) => name.endsWith(".py")).sort()).toEqual([
      "__init__.py", "binding.py", "gateway_config.py", "ir_actions_report.py", "pos_order.py", "print_job.py", "print_router.py",
    ]);
  });
});
