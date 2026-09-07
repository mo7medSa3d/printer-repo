import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("document-type routing contract", () => {
  it("normalizes explicit document types and derives known Odoo models centrally", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/print_router.py", "utf8");
    expect(src).toContain('normalized = str(value).strip().lower()');
    expect(src).toContain('"sale.order": "order"');
    expect(src).toContain('"account.move": "invoice"');
    expect(src).toContain('"stock.picking": "delivery"');
    expect(src).toContain('"purchase.order": "purchase_order"');
    expect(src).toContain('"pos.order": "receipt"');
  });

  it("has specialized entry points converge on the same submit route", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/print_router.py", "utf8");
    expect(src).toContain("def route_report(");
    expect(src).toContain("def route_pos_receipt(");
    expect(src).toContain("def route_kitchen_print(");
    expect(src).toContain("def route_pos_sale_details(");
    expect(src).toContain("_submit_route(route=route");
  });
});
