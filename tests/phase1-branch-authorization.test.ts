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

/**
 * A printer as the gateway now loads it: WITHOUT a branch column, but WITH the
 * owning agent joined in. The branch under test is the AGENT's branch — the
 * only branch a printer has.
 */
function makePrinter(agentBranchId: string | null) {
  return {
    id: "printer_1",
    agentId: "agent_1",
    enabled: true,
    status: "online",
    protocol: "raw",
    connectionType: "network",
    name: "Printer 1",
    agent: { id: "agent_1", branchId: agentBranchId },
  };
}

/** A printer whose agent row is missing entirely (broken ownership chain). */
function makePrinterWithoutAgent() {
  return { id: "printer_1", agentId: "agent_gone", enabled: true, status: "online", agent: null };
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

  it("blocks a branch-A-scoped key from creating a legacy job against a printer whose AGENT is in branch B", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter("branch_b"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(403);
  });

  it("still allows a branch-A-scoped key when the printer's agent is in branch A", async () => {
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

  it("fails closed when the printer → agent → branch chain is broken", async () => {
    // Knowing a printer id must never be enough to print when the printer's
    // branch cannot be derived: there is no branch to authorize against, so the
    // request must be refused rather than treated as unscoped.
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinterWithoutAgent());
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("branch is derived through its agent");
  });

  it("fails closed when the owning agent has no branch", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter(null));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("has no branch");
  });
});
