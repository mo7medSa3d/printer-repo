import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const posRouter = readFileSync(
  join(root, "odoo_addons/print_gateway/static/src/js/pos_print_router.js"),
  "utf8",
);
const centralRouter = readFileSync(
  join(root, "odoo_addons/print_gateway/models/print_router.py"),
  "utf8",
);
const keyRoute = readFileSync(
  join(root, "src/app/api/odoo/keys/route.ts"),
  "utf8",
);

describe("central print router contracts", () => {
  it("routes POS printing through the server before allowing native printing", () => {
    expect(posRouter).toContain('action_print_gateway_receipt');
    expect(posRouter).toContain('return super.printReceipt({ order, basic, printBillActionTriggered });');
    expect(posRouter).toContain('throw error;');
    expect(posRouter).not.toContain('window.print(');
  });

  it("has a single Odoo integration entry point", () => {
    expect(centralRouter).toContain('print_gateway.print_router');
    expect(centralRouter).toContain('route_report');
    expect(centralRouter).toContain('route_pos_receipt');
    expect(centralRouter).not.toContain('super().report_action');
  });

  it("creates installation-level Odoo keys without branch configuration", () => {
    expect(keyRoute).toContain('branchId: null');
    expect(keyRoute).toContain('scope: "standard"');
    expect(keyRoute).toContain('allowedDocumentTypes: null');
    expect(keyRoute).toContain('raw secret is never shown again');
    expect(keyRoute).not.toContain('body.branchId');
  });
});
