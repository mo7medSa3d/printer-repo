import { describe, expect, it } from "vitest";
import { selectBestBinding, type BindingCandidate } from "../src/lib/routing";

// Parity contract (audit #19): document-type routing normalization must be
// deterministic and match what the Odoo-side documentation promises —
// case/whitespace-insensitive, exact match preferred, and NO silent
// fallback to an unrelated binding (the gateway answers NO_ROUTE instead).
// The Odoo addon no longer carries its own (divergent) routing logic; the
// Gateway is the single authority for routing.

const base: Omit<BindingCandidate, "documentType" | "printerId" | "priority"> = {
  id: "binding_1",
  branchId: "branch_1",
  destinationId: "dest_1",
  enabled: true,
};

const row = (over: Partial<BindingCandidate>): BindingCandidate => ({
  ...base,
  documentType: null,
  printerId: "printer_default",
  priority: 10,
  ...over,
});

describe("routing document-type parity (case/whitespace)", () => {
  it("matches upper, lower and mixed case against the same stored type", () => {
    const rows = [row({ id: "b_order", documentType: "order", printerId: "printer_order" })];
    expect(selectBestBinding(rows, "order")?.printerId).toBe("printer_order");
    expect(selectBestBinding(rows, "ORDER")?.printerId).toBe("printer_order");
    expect(selectBestBinding(rows, "Order")?.printerId).toBe("printer_order");
    expect(selectBestBinding(rows, "oRdEr")?.printerId).toBe("printer_order");
  });

  it("trims whitespace on both the stored and the requested type", () => {
    const rows = [row({ id: "b_order", documentType: "  order ", printerId: "printer_order" })];
    expect(selectBestBinding(rows, "order")?.printerId).toBe("printer_order");
    expect(selectBestBinding(rows, "  ORDER  ")?.printerId).toBe("printer_order");
  });

  it("prefers an exact document-type match over a wildcard binding", () => {
    const rows = [
      row({ id: "b_wild", documentType: null, printerId: "printer_default", priority: 1 }),
      row({ id: "b_receipt", documentType: "RECEIPT", printerId: "printer_receipt", priority: 9 }),
    ];
    // Even though the wildcard has better (lower) priority, the exact
    // match wins — this is the rule the removed Odoo helper also had to
    // approximate.
    expect(selectBestBinding(rows, "receipt")?.printerId).toBe("printer_receipt");
  });

  it("falls back to the wildcard binding when the type does not match", () => {
    const rows = [
      row({ id: "b_wild", documentType: null, printerId: "printer_default", priority: 1 }),
      row({ id: "b_receipt", documentType: "receipt", printerId: "printer_receipt", priority: 9 }),
    ];
    expect(selectBestBinding(rows, "invoice")?.printerId).toBe("printer_default");
  });

  it("returns null (NO_ROUTE) instead of an unrelated binding", () => {
    const rows = [row({ id: "b_receipt", documentType: "receipt", printerId: "printer_receipt" })];
    expect(selectBestBinding(rows, "invoice")).toBeNull();
  });

  it("ignores disabled bindings regardless of case", () => {
    const rows = [row({ id: "b_order", documentType: "order", printerId: "printer_order", enabled: false })];
    expect(selectBestBinding(rows, "ORDER")).toBeNull();
  });
});
