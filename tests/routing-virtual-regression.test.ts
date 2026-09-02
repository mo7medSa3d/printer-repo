import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Routing regression: the virtual-printer filter must not change how
 * physical printers are chosen.
 *
 * `resolvePrinterForJob` talks to the database, so `@/db` is replaced with a
 * test double. Everything else is the real routing layer, so these tests
 * exercise the actual candidate loop rather than re-implementing it.
 */

const state = vi.hoisted(() => ({
  branch: { id: "branch_a" } as any,
  destination: { id: "dest_pos", branchId: "branch_a" } as any,
  bindings: [] as any[],
  printers: {} as Record<string, any>,
  agents: {} as Record<string, any>,
  printerCalls: 0,
}));

/**
 * Reads the id out of a `where: eq(table.id, "…")` expression, so the double
 * honours whichever candidate the routing loop actually asks for (it iterates
 * candidates in priority order, not insertion order).
 */
function collectParams(node: any, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectParams(n, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.constructor?.name === "Param" && "value" in node) {
      out.push(String(node.value));
      return out;
    }
    if (Array.isArray(node.queryChunks)) collectParams(node.queryChunks, out);
  }
  return out;
}

function requestedId(where: any): string | null {
  return collectParams(where)[0] ?? null;
}

vi.mock("@/db", () => ({
  db: {
    query: {
      branches: { findFirst: async ({ where }: any) => (requestedId(where) === state.branch?.id ? state.branch : null) },
      destinations: {
        findFirst: async ({ where }: any) => {
          const id = requestedId(where);
          return id && state.destination && id === state.destination.id ? state.destination : null;
        },
      },
      printerBindings: { findMany: async () => state.bindings },
      printers: {
        findFirst: async ({ where }: any) => {
          const id = requestedId(where);
          return id ? (state.printers[id] ?? null) : null;
        },
      },
      agents: {
        findFirst: async ({ where }: any) => {
          const id = requestedId(where);
          return id ? (state.agents[id] ?? null) : null;
        },
      },
    },
  },
}));

import { resolvePrinterForJob } from "@/lib/routing";

function bind(printerId: string, priority: number, id = `b_${printerId}`) {
  return { id, branchId: "branch_a", destinationId: "dest_pos", documentType: "receipt", printerId, priority, enabled: true };
}

function printer(id: string, opts: { enabled?: boolean; status?: string; name?: string; capabilities?: unknown; printerType?: string; branchId?: string } = {}) {
  const agentId = `agent_${id}`;
  return {
    id,
    agentId,
    // Branch comes from the agent relation only — printers have no branch
    // column. The double therefore returns the joined agent, exactly like
    // `db.query.printers.findFirst({ with: { agent: true } })` does.
    agent: { id: agentId, branchId: opts.branchId ?? "branch_a" },
    name: opts.name ?? id,
    printerType: opts.printerType ?? "laser",
    connectionType: "spooler",
    protocol: "raw",
    status: opts.status ?? "online",
    enabled: opts.enabled ?? true,
    capabilities: opts.capabilities ?? { supported_protocols: ["raw", "escpos", "pdf"] },
  };
}

const VIRTUAL = {
  name: "Microsoft Print to PDF",
  printerType: "virtual",
  capabilities: { port_name: "PORTPROMPT:" },
};

function setup(printers: any[], bindings: any[]) {
  state.printers = Object.fromEntries(printers.map((p) => [p.id, p]));
  state.agents = Object.fromEntries(printers.map((p) => [p.agentId, p.agent]));
  state.bindings = bindings;
  state.printerCalls = 0;
}

const job = { branchId: "branch_a", destinationId: "dest_pos", documentType: "receipt" as const, payloadType: "raw" as const };

describe("routing regression: physical printers stay routable", () => {
  beforeEach(() => {
    state.printers = {};
    state.bindings = [];
    state.agents = {};
    state.printerCalls = 0;
  });

  it("selects an available physical printer", async () => {
    setup([printer("printer_physical")], [bind("printer_physical", 1)]);
    const res = await resolvePrinterForJob(job);
    expect(res).not.toBeNull();
    if (!res || "error" in res) throw new Error(`expected a resolved printer, got ${JSON.stringify(res)}`);
    expect(res.printer.id).toBe("printer_physical");
    expect(res.fallbackUsed).toBe(false);
    expect(res.fallbackChain).toEqual(["printer_physical"]);
  });

  it("keeps priority order among physical printers", async () => {
    setup(
      [printer("printer_low"), printer("printer_high")],
      [bind("printer_low", 50), bind("printer_high", 1)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || "error" in res) throw new Error(`expected a resolved printer, got ${JSON.stringify(res)}`);
    expect(res.printer.id).toBe("printer_high");
  });
});

describe("routing regression: virtual printers never win", () => {
  beforeEach(() => {
    state.printers = {};
    state.bindings = [];
    state.agents = {};
    state.printerCalls = 0;
  });

  it("skips a higher-priority virtual printer and uses the physical one", async () => {
    setup(
      [printer("printer_virtual", VIRTUAL), printer("printer_physical")],
      [bind("printer_virtual", 1), bind("printer_physical", 2)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || "error" in res) throw new Error(`expected the physical printer, got ${JSON.stringify(res)}`);
    expect(res.printer.id).toBe("printer_physical");
    expect(res.fallbackUsed).toBe(true);
    expect(res.fallbackChain).toEqual(["printer_virtual", "printer_physical"]);
  });

  it("returns PRINTER_VIRTUAL when every candidate is virtual", async () => {
    setup(
      [printer("printer_pdf", VIRTUAL), printer("printer_xps", { name: "Microsoft XPS Document Writer", printerType: "virtual", capabilities: { port_name: "XPSPort:" } })],
      [bind("printer_pdf", 1), bind("printer_xps", 2)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || !("error" in res)) throw new Error(`expected an error, got ${JSON.stringify(res)}`);
    expect(res.error).toBe("PRINTER_VIRTUAL");
  });

  it("reports PRINTER_OFFLINE when the physical candidate is offline (virtual skipped)", async () => {
    setup(
      [printer("printer_virtual", VIRTUAL), printer("printer_physical", { status: "offline" })],
      [bind("printer_virtual", 1), bind("printer_physical", 2)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || !("error" in res)) throw new Error(`expected an error, got ${JSON.stringify(res)}`);
    // Existing semantics preserved: an offline printer is still PRINTER_OFFLINE
    // (503, retry later) — the virtual feature does not mask it.
    expect(res.error).toBe("PRINTER_OFFLINE");
  });

  it("reports PRINTER_DISABLED when the physical candidate is disabled", async () => {
    setup(
      [printer("printer_virtual", VIRTUAL), printer("printer_physical", { enabled: false })],
      [bind("printer_virtual", 1), bind("printer_physical", 2)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || !("error" in res)) throw new Error(`expected an error, got ${JSON.stringify(res)}`);
    expect(res.error).toBe("PRINTER_DISABLED");
  });

  it("picks the physical printer when it comes after two virtual ones", async () => {
    setup(
      [
        printer("printer_pdf", VIRTUAL),
        printer("printer_onenote", { name: "OneNote (Desktop)", printerType: "virtual", capabilities: { port_name: "nul:" } }),
        printer("printer_physical"),
      ],
      [bind("printer_pdf", 1), bind("printer_onenote", 2), bind("printer_physical", 3)]
    );
    const res = await resolvePrinterForJob(job);
    if (!res || "error" in res) throw new Error(`expected the physical printer, got ${JSON.stringify(res)}`);
    expect(res.printer.id).toBe("printer_physical");
    expect(res.fallbackChain).toEqual(["printer_pdf", "printer_onenote", "printer_physical"]);
  });
});
