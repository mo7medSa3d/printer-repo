import { describe, expect, it } from "vitest";
import { isOdooKeyAllowedForDocumentType, isBranchScopedKeyAllowed } from "@/lib/odoo-auth";

describe("Phase 1 branch authorization", () => {
  it("rejects a branch-scoped key when the request targets another branch", () => {
    expect(isBranchScopedKeyAllowed("branch_a", "branch_b")).toBe(false);
    expect(isBranchScopedKeyAllowed("branch_a", "branch_a")).toBe(true);
    expect(isBranchScopedKeyAllowed(null, "branch_b")).toBe(true);
  });

  it("blocks read_only keys from writing jobs", () => {
    expect(isOdooKeyAllowedForDocumentType({ scope: "read_only", allowedDocumentTypes: ["receipt"] }, "receipt", "write")).toBe(false);
    expect(isOdooKeyAllowedForDocumentType({ scope: "standard", allowedDocumentTypes: ["receipt"] }, "receipt", "write")).toBe(true);
  });

  it("enforces document-type allowlists when configured", () => {
    expect(isOdooKeyAllowedForDocumentType({ allowedDocumentTypes: ["receipt", "label"] }, "invoice", "write")).toBe(false);
    expect(isOdooKeyAllowedForDocumentType({ allowedDocumentTypes: ["receipt", "label"] }, "label", "write")).toBe(true);
  });
});
