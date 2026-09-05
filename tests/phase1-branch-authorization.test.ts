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

// C1 regression: the legacy API must enforce the Odoo key's branch scope.
// The route now delegates actual job creation to the shared service, so the
// mock must include every DB relation that the shared service reads.
const findFirstMocks = {
  apiKeys: vi.fn(),
  printers: vi.fn(),
  agents: vi.fn(),
  branches: vi.fn(),
  printJobs: vi.fn(),
};

vi.mock("@/db", () => {
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }),
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
  };

  return {
    db: {
      query: {
        apiKeys: { findFirst: (...args: unknown[]) => findFirstMocks.apiKeys(...args) },
        printers: { findFirst: (...args: unknown[]) => findFirstMocks.printers(...args) },
        agents: { findFirst: (...args: unknown[]) => findFirstMocks.agents(...args) },
        branches: { findFirst: (...args: unknown[]) => findFirstMocks.branches(...args) },
        printJobs: { findFirst: (...args: unknown[]) => findFirstMocks.printJobs(...args) },
      },
      transaction: async (callback: (tx: any) => Promise<unknown>) => callback(tx),
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

function makePrinter() {
  return { id: "printer_1", agentId: "agent_1", lifecycle: "active", status: "online", protocol: "spooler", connectionType: "spooler", capabilities: { supported_protocols: ["raw"] } };
}

function makeAgent(branchId: string) {
  return { id: "agent_1", branchId, lifecycle: "active", status: "online", lastSeenAt: new Date() };
}

function makeBranch(branchId: string) {
  return { id: branchId, enabled: true };
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
    findFirstMocks.agents.mockReset();
    findFirstMocks.branches.mockReset();
    findFirstMocks.printJobs.mockReset();
  });

  it("blocks a branch-A-scoped key from creating a legacy job against a branch-B printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter());
    findFirstMocks.agents.mockResolvedValue(makeAgent("branch_b"));
    findFirstMocks.branches.mockResolvedValue(makeBranch("branch_b"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(403);
  });

  it("still allows a branch-A-scoped key against a branch-A printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey("branch_a"));
    findFirstMocks.printers.mockResolvedValue(makePrinter());
    findFirstMocks.agents.mockResolvedValue(makeAgent("branch_a"));
    findFirstMocks.branches.mockResolvedValue(makeBranch("branch_a"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(201);
  });

  it("still allows a global (null-branch) key against any branch's printer", async () => {
    findFirstMocks.apiKeys.mockResolvedValue(makeOdooKey(null));
    findFirstMocks.printers.mockResolvedValue(makePrinter());
    findFirstMocks.agents.mockResolvedValue(makeAgent("branch_b"));
    findFirstMocks.branches.mockResolvedValue(makeBranch("branch_b"));
    const { POST } = await import("@/app/api/print/jobs/route");

    const res = await POST(legacyRequest());
    expect(res.status).toBe(201);
  });
});
