import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
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

// --- C1 regression: legacy POST /api/print/jobs branch isolation ---
//
// Mocks @/db (a lazily-connected module, safe to mock without a live PG)
// so the actual route handler runs end-to-end against fake rows, proving
// the fix at the HTTP boundary rather than only at the helper-function level.

const findFirstMocks = {
  apiKeys: vi.fn(),
  printers: vi.fn(),
  printJobs: vi.fn(),
};

vi.mock("@/db", () => {
  return {
    db: {
      query: {
        apiKeys: { findFirst: (...args: unknown[]) => findFirstMocks.apiKeys(...args) },
        printers: { findFirst: (...args: unknown[]) => findFirstMocks.printers(...args) },
        printJobs: { findFirst: (...args: unknown[]) => findFirstMocks.printJobs(...args) },
      },
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

function makeOdooKey(branchId: string | null) {
  return {
    id: "key_1",
    branchId,
    scope: "standard",
    allowedDocumentTypes: null,
    hashedKey: createHash("sha256").update("odoo_testkey").digest("hex"),
    revokedAt: null,
  };
}

function makePrinter(branchId: string | null) {
  return { id: "printer_1", agentId: "agent_1", lifecycle: "active" };
}

function legacyRequest() {
  return new Request("http://localhost/api/print/jobs", {
    method: "POST",
    headers: { authorization: "Bearer odoo_testkey", "content-type": "application/json" },
    body: JSON.stringify({
      printerId: "printer_1",
      payload: { type: "raw", encoding: "base64", data: Buffer.from("hi").toString("base64") },
    }),
  });
}

describe("C1 regression — legacy POST /api/print/jobs branch isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    findFirstMocks.apiKeys.mockReset();
    findFirstMocks.printers.mockReset();
    findFirstMocks.printJobs.mockReset();
  });

  it("blocks a branch-A-scoped key from creating a legacy job against a branch-B printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter("branch_b"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(403);
  });

  it("still allows a branch-A-scoped key against a branch-A printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter("branch_a"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(201);
  });

  it("still allows a global (null-branch) key against any branch's printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey(null));
    findFirstMocks.printers.mockResolvedValue(makePrinter("branch_b"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(201);
  });
});
