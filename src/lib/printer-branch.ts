import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Printer → Branch resolution.
 *
 * The canonical ownership chain is:
 *
 *     Branch → Agent → Printer
 *
 * `printers` has NO branch column (see drizzle/0006_printer_branch_via_agent.sql).
 * Every place that needs "which branch is this printer in?" MUST go through
 * this module so there is exactly one implementation of the derivation, and
 * so no caller can accidentally reintroduce a second branch authority or a
 * `printer.branchId ?? defaultBranch` style fallback.
 *
 * Nothing here ever invents, defaults or falls back to a branch: a printer
 * whose agent cannot be resolved has NO branch, and callers must treat that
 * as a hard failure rather than as "global".
 */

export type PrinterRow = typeof printers.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type PrinterRef = { id: string; agentId: string };

/** A printer joined with the agent that owns it, and therefore with its branch. */
export type PrinterWithBranch<P extends PrinterRef = PrinterRef> = P & {
  agent: { id: string; branchId: string; name?: string | null; status?: string | null; lastSeenAt?: Date | null };
  /** Derived, read-only. Always equals `agent.branchId`. Never stored. */
  branchId: string;
};

export type PrinterBranchError =
  | { error: "PRINTER_NOT_FOUND"; message: string }
  | { error: "PRINTER_AGENT_MISSING"; message: string }
  | { error: "AGENT_BRANCH_MISSING"; message: string };

/**
 * Derive the branch of an already-loaded printer row given its agent row.
 * Returns null when the chain is broken — callers must fail, not default.
 */
export function branchIdOfPrinter(
  printer: { id: string; agentId?: string | null } | null | undefined,
  agent: { id: string; branchId?: string | null } | null | undefined
): string | null {
  if (!printer || !printer.agentId) return null;
  if (!agent || agent.id !== printer.agentId) return null;
  return agent.branchId ?? null;
}

/**
 * Load a printer together with its owning agent, and expose the derived
 * branch. This is the single read path used by API routes, server actions and
 * routing.
 */
export type LoadedPrinter = PrinterRow & {
  agent: AgentRow;
  /** Derived, read-only: always `agent.branchId`. Never stored on the printer. */
  branchId: string;
};

export async function loadPrinterWithBranch(
  printerId: string
): Promise<{ ok: true; printer: LoadedPrinter } | ({ ok: false } & PrinterBranchError)> {
  const row = await db.query.printers.findFirst({
    where: eq(printers.id, printerId),
    with: { agent: true },
  });
  if (!row) {
    return { ok: false, error: "PRINTER_NOT_FOUND", message: `printer ${printerId} not found` };
  }
  const agent = (row as any).agent as { id: string; branchId: string | null } | null | undefined;
  if (!agent) {
    return {
      ok: false,
      error: "PRINTER_AGENT_MISSING",
      message: `printer ${printerId} references agent ${(row as any).agentId} which does not exist; a printer's branch is derived through its agent`,
    };
  }
  if (!agent.branchId) {
    return {
      ok: false,
      error: "AGENT_BRANCH_MISSING",
      message: `agent ${agent.id} owning printer ${printerId} has no branch; agent is the sole owner of branch context`,
    };
  }
  return { ok: true, printer: { ...(row as any), branchId: agent.branchId } };
}

/**
 * Bulk variant: printerId → branchId, derived through the agents table with a
 * single join. Printers whose chain is broken are simply absent from the map
 * (callers decide how to fail).
 */
export async function branchIdsForPrinters(printerIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(printerIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return map;
  const rows = await db
    .select({ printerId: printers.id, branchId: agents.branchId })
    .from(printers)
    .innerJoin(agents, eq(printers.agentId, agents.id))
    .where(inArray(printers.id, unique));
  for (const r of rows) {
    if (r.branchId) map.set(r.printerId, r.branchId);
  }
  return map;
}

/**
 * List every printer in a branch by walking branch → agents → printers.
 * There is no `printers.branch_id` to filter on, by design.
 */
export async function listPrintersInBranch(branchId: string) {
  const rows = await db
    .select()
    .from(printers)
    .innerJoin(agents, eq(printers.agentId, agents.id))
    .where(eq(agents.branchId, branchId));
  // Flatten the join and attach the derived branch so callers keep the exact
  // same row shape they had when the column still existed — minus the ability
  // to write it.
  return rows.map((r: any) => ({ ...r.printers, branchId: r.agents.branchId, agent: r.agents }));
}

/**
 * Guard for any operation that supplies BOTH a printer and a branch context.
 * If the caller's branch does not match the branch derived through the
 * printer's agent, the operation must fail safely rather than proceed.
 */
export function assertPrinterInBranch(
  derivedBranchId: string | null,
  requestedBranchId: string | null | undefined,
  printerId: string
): { ok: true } | { ok: false; message: string } {
  if (!requestedBranchId) return { ok: true };
  if (!derivedBranchId) {
    return { ok: false, message: `printer ${printerId} has no resolvable branch (broken printer → agent → branch chain)` };
  }
  if (String(derivedBranchId) !== String(requestedBranchId)) {
    return {
      ok: false,
      message: `printer ${printerId} belongs to branch ${derivedBranchId} (via its agent), not to the requested branch ${requestedBranchId}`,
    };
  }
  return { ok: true };
}
