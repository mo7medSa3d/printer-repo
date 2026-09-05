import { describe, expect, it } from "vitest";
import { isBranchScopedKeyAllowed } from "../src/lib/odoo-auth";
import { selectBestBinding } from "../src/lib/routing";

describe("Phase 1 multi-branch routing", () => {
  it("prefers the lowest priority enabled binding for the requested document type", () => {
    const rows = [
      { id: "b1", branchId: "branch_a", destinationId: "dest_pos", documentType: "receipt", printerId: "printer_1", priority: 50, enabled: true },
      { id: "b2", branchId: "branch_a", destinationId: "dest_pos", documentType: "receipt", printerId: "printer_2", priority: 10, enabled: true },
      { id: "b3", branchId: "branch_a", destinationId: "dest_pos", documentType: "invoice", printerId: "printer_3", priority: 1, enabled: true },
      { id: "b4", branchId: "branch_a", destinationId: "dest_pos", documentType: "receipt", printerId: "printer_disabled", priority: 1, enabled: false },
    ];

    expect(selectBestBinding(rows, "receipt")?.printerId).toBe("printer_2");
  });

  it("falls back to non-specific document type bindings when no exact match exists", () => {
    const rows = [
      { id: "b1", branchId: "branch_a", destinationId: "dest_pos", documentType: null, printerId: "printer_default", priority: 100, enabled: true },
      { id: "b2", branchId: "branch_a", destinationId: "dest_pos", documentType: "invoice", printerId: "printer_invoice", priority: 1, enabled: true },
    ];

    expect(selectBestBinding(rows, "receipt")?.printerId).toBe("printer_default");
  });

  it("rejects branch-scoped API keys for another branch", () => {
    expect(isBranchScopedKeyAllowed("branch_a", "branch_b")).toBe(false);
    expect(isBranchScopedKeyAllowed(null, "branch_b")).toBe(true);
    expect(isBranchScopedKeyAllowed("branch_a", "branch_a")).toBe(true);
  });
});
