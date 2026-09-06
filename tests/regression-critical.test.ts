import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Existing regression suite content retained below; only the PDF/report
// assertions are aligned with the current production contract.

describe("regression: Odoo payload_type contract", () => {
  it("ir_actions_report always emits QWeb reports as honest PDF payloads", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/ir_actions_report.py", "utf8");
    expect(src).toContain("desired_type");
    expect(src).toContain("return {");
    expect(src).toContain("'type': 'pdf'");
    expect(src).toContain("no PDF-to-ESC/POS conversion is configured");
  });

  it("report_mapping help is honest", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/report_mapping.py", "utf8");
    expect(src).not.toContain("will try to convert");
    expect(src).toContain("QWeb reports remain PDF payloads");
    expect(src).toContain("RAW/ESC/POS jobs use the direct print-job API");
  });
});

describe("regression: Odoo native contextual routing", () => {
  it("supports POS and warehouse operation type route contexts", () => {
    const src = readFileSync("odoo_addons/print_gateway/models/report_mapping.py", "utf8");
    expect(src).toContain("pos_config_id = fields.Many2one");
    expect(src).toContain("picking_type_id = fields.Many2one");
    expect(src).toContain("record._name == 'pos.order'");
    expect(src).toContain("record._name == 'stock.picking'");
  });
});
