import { db } from "@/db";
import { branches, destinations, printerBindings, printers } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { isVirtualPrinterRecord, type PrinterLike } from "./printer-virtual";
import { branchIdOfPrinter } from "./printer-branch";

export type BindingCandidate = {
  id: string;
  branchId: string;
  destinationId: string;
  documentType: string | null;
  printerId: string;
  priority: number;
  enabled: boolean;
};

/**
 * Total ordering for routing candidates.
 *
 * Priority alone is NOT a total order: two bindings in the same
 * (branch, destination, documentType) routing key may legitimately share a
 * priority, and in that case `Array.prototype.sort` plus PostgreSQL's
 * unspecified row order would let the chosen printer vary between identical
 * requests — the same receipt could come out of a different printer each time.
 *
 * The documented rule is therefore:
 *
 *   1. priority ASC        (lower number wins; the operator's intent)
 *   2. binding.id ASC      (stable, unique tie-break)
 *
 * Because binding ids are unique, this is a strict total order: the same set of
 * candidates always yields the same winner, regardless of row order.
 *
 * A more specific document type still beats a wildcard — that is handled by the
 * caller's filtering, not here.
 */
export function compareBindings(a: BindingCandidate, b: BindingCandidate): number {
  const byPriority = Number(a.priority ?? 0) - Number(b.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  // Deterministic tie-break. Never fall through to input order.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function selectBestBinding(bindingRows: BindingCandidate[], requestedDocumentType?: string | null) {
  const normalized = (requestedDocumentType ?? "").trim().toLowerCase();

  const candidates = [...bindingRows]
    .filter((binding) => binding.enabled !== false)
    .filter((binding) => {
      const bindingType = (binding.documentType ?? "").trim().toLowerCase();
      return bindingType === "" || bindingType === normalized || normalized === "";
    })
    .sort(compareBindings);

  return candidates[0] ?? null;
}

export function selectFallbackBindings(bindingRows: BindingCandidate[], requestedDocumentType?: string | null): BindingCandidate[] {
  const normalized = (requestedDocumentType ?? "").trim().toLowerCase();
  return [...bindingRows]
    .filter((binding) => binding.enabled !== false)
    .filter((binding) => {
      const bindingType = (binding.documentType ?? "").trim().toLowerCase();
      return bindingType === "" || bindingType === normalized || normalized === "";
    })
    .sort(compareBindings);
}

export type CapabilityCheckResult = { ok: true } | { ok: false; reason: string };

export function validatePayloadForPrinter(
  payloadType: string | null | undefined,
  printer: { protocol?: string | null; capabilities?: { supported_protocols?: string[] } | null; connectionType?: string | null; printerType?: string | null }
): CapabilityCheckResult {
  if (!payloadType) return { ok: true };
  const pt = payloadType.toLowerCase();
  const proto = (printer.protocol ?? "").toLowerCase();
  const conn = (printer.connectionType ?? "").toLowerCase();

  // If the printer explicitly lists supported protocols, enforce it strictly.
  const supported = printer.capabilities?.supported_protocols?.map((s) => s.toLowerCase());
  if (supported && supported.length > 0) {
    if (supported.includes(pt)) return { ok: true };
    // A byte-stream payload (raw/escpos) may go to any byte-stream transport:
    // spooler RAW mode and ESC/POS devices both accept an opaque byte stream.
    if (pt === "raw" || pt === "escpos") {
      if (supported.includes("raw") || supported.includes("escpos") || conn === "spooler" || proto === "spooler") {
        return { ok: true };
      }
      return { ok: false, reason: `CAPABILITY_MISMATCH: payload type ${pt} not in printer supported_protocols [${supported.join(",")}]` };
    }
    // PDF is NEVER inferred from "raw" support: a PDF handed to an ESC/POS
    // byte-stream printer prints garbage. A printer must declare pdf (or an
    // IPP transport that carries application/pdf) to receive PDF jobs.
    return {
      ok: false,
      reason: `CAPABILITY_MISMATCH: payload type ${pt} not in printer supported_protocols [${supported.join(",")}]`,
    };
  }

  // IPP is now a first-class transport with real IPP client (ipp.go).
  // IPP printers accept raw/escpos via application/octet-stream (Print-Job).
  if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") {
    if (pt === "raw" || pt === "escpos" || pt === "ipp" || pt === "ipps" || pt === "pdf" || pt === "pcl") {
      return { ok: true };
    }
    // For unknown payload types, allow IPP if it declares support
    if (supported && supported.includes("ipp")) return { ok: true };
  }
  if (pt === "raw") {
    if (["raw", "escpos", "spooler", ""].includes(proto) || conn === "spooler") return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: raw payload incompatible with printer protocol ${proto}` };
  }
  if (pt === "escpos") {
    if (["escpos", "raw", "spooler", ""].includes(proto) || conn === "spooler") return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: escpos payload incompatible with printer protocol ${proto}` };
  }
  if (pt === "pdf") {
    // PDF requires a spooler/IPP path that can render PDF (Windows driver or IPP PDF).
    // Never send PDF directly to raw TCP ESC/POS thermal printers.
    if (conn === "spooler" || proto === "spooler") return { ok: true };
    if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") return { ok: true };
    // Thermal/label printers via raw TCP must not receive PDF
    return { ok: false, reason: `CAPABILITY_MISMATCH: pdf payload requires spooler or IPP printer (got ${proto}/${conn})` };
  }
  // For other unknown payload types (e.g., pcl), only spooler/IPP are assumed capable
  if (conn === "spooler" || proto === "spooler") return { ok: true };
  if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") return { ok: true };
  return { ok: false, reason: `CAPABILITY_MISMATCH: payload ${pt} incompatible with printer ${proto}/${conn}` };
}

/** Minimal printer shape the routing availability check needs. */
export interface PrinterAvailability extends PrinterLike {
  enabled: boolean | null;
  status: string | null;
}

export function isPrinterAvailableForJob(printer: PrinterAvailability): boolean {
  if (printer.enabled === false) return false;
  // Virtual / software / redirected queues are never a production route, even
  // if an older agent version already registered one.
  if (isVirtualPrinterRecord(printer)) return false;
  // Offline printers may trigger fallback; we treat offline as unavailable for routing
  // "unknown" is considered available (we don't know it's offline) to avoid blocking
  if (printer.status === "offline" || printer.status === "error") return false;
  return true;
}

export type ResolveErrorCode =
  | "INVALID_BRANCH"
  | "INVALID_DESTINATION"
  | "NO_ROUTE"
  | "NO_PRINTER_FOUND"
  | "PRINTER_DISABLED"
  | "PRINTER_VIRTUAL"
  | "PRINTER_OFFLINE"
  | "CAPABILITY_MISMATCH"
  | "CROSS_BRANCH_BINDING"
  | "INTERNAL_ERROR";

export async function resolvePrinterForJob({
  branchId,
  destinationId,
  documentType,
  payloadType,
}: {
  branchId: string;
  destinationId: string;
  documentType?: string | null;
  payloadType?: string | null;
}): Promise<
  | { branch: any; destination: any; binding: BindingCandidate; printer: any; fallbackUsed: boolean; fallbackChain: string[] }
  | { error: ResolveErrorCode; message: string }
  | null
> {
  try {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId) });
    if (!branch) return { error: "INVALID_BRANCH", message: `Branch ${branchId} not found` };

    const destination = await db.query.destinations.findFirst({
      where: and(eq(destinations.id, destinationId), eq(destinations.branchId, branchId)),
    });
    if (!destination) return { error: "INVALID_DESTINATION", message: `Destination ${destinationId} not found in branch ${branchId}` };

    const rows = await db.query.printerBindings.findMany({
      where: and(
        eq(printerBindings.branchId, branchId),
        eq(printerBindings.destinationId, destinationId),
        eq(printerBindings.enabled, true)
      ),
      // Deterministic at the SQL level too, matching compareBindings(). Row
      // order from PostgreSQL is otherwise unspecified.
      orderBy: [asc(printerBindings.priority), asc(printerBindings.id)],
    });

    if (!rows || rows.length === 0) {
      return { error: "NO_ROUTE", message: `No printer binding found for branch ${branchId} destination ${destinationId} documentType ${documentType}` };
    }

    const candidates = selectFallbackBindings(rows as BindingCandidate[], documentType ?? null);
    if (candidates.length === 0) {
      return { error: "NO_ROUTE", message: `No matching binding for documentType ${documentType}` };
    }

    const fallbackChain: string[] = [];
    let lastOfflinePrinter: string | null = null;
    let lastDisabledPrinter: string | null = null;
    let lastVirtualPrinter: string | null = null;
    let lastCapabilityReason: string | null = null;
    let crossBranchPrinter: string | null = null;

    for (let idx = 0; idx < candidates.length; idx++) {
      const binding = candidates[idx];
      fallbackChain.push(binding.printerId);

      // Load the printer WITH its owning agent: the agent is the sole owner of
      // branch context, so the join is what makes the branch check possible at
      // all. There is no branch column on the printer row to read, and
      // therefore no printer-branch fallback that could silently pick the
      // requested branch instead of the real one.
      const printer = await db.query.printers.findFirst({
        where: eq(printers.id, binding.printerId),
        with: { agent: true },
      });

      if (!printer) {
        // Printer record missing — try next fallback
        continue;
      }

      // Branch consistency, derived: printer → agent → branch. A printer whose
      // agent is missing or branch-less has NO branch and is never routable.
      const owningAgent = ((printer as any).agent ?? null) as { id: string; branchId: string | null } | null;
      const derivedBranchId = branchIdOfPrinter(printer as any, owningAgent);
      if (!derivedBranchId || derivedBranchId !== branchId) {
        // Cross-branch (or unresolvable) binding — never route it, try the
        // next fallback candidate instead.
        crossBranchPrinter = printer.id;
        continue;
      }

      // Virtual check. A virtual/software/redirected queue is never a
      // production route — skip it and let the next binding take over.
      if (isVirtualPrinterRecord(printer)) {
        lastVirtualPrinter = printer.id;
        continue; // try fallback
      }

      // Enabled check. An administratively disabled printer is a distinct,
      // non-transient condition from an offline one: it is reported as
      // PRINTER_DISABLED (409, fix it in configuration) instead of
      // PRINTER_OFFLINE (503, retry later).
      if (printer.enabled === false) {
        lastDisabledPrinter = printer.id;
        continue; // try fallback
      }

      // Offline check — fallback per spec
      if (printer.status === "offline" || printer.status === "error") {
        lastOfflinePrinter = printer.id;
        continue;
      }

      // Capability validation
      if (payloadType) {
        const cap = validatePayloadForPrinter(payloadType, {
          protocol: (printer as any).protocol,
          connectionType: (printer as any).connectionType,
          capabilities: (printer as any).capabilities,
        });
        if (!cap.ok) {
          lastCapabilityReason = cap.reason;
          continue;
        }
      }

      const fallbackUsed = idx > 0;
      // Auditable: include fallbackChain
      return {
        branch,
        destination,
        binding,
        // `branchId` here is DERIVED (printer → agent → branch) and is exposed
        // read-only for logging/auditing. It is never written back to the
        // printers table, which has no branch column.
        printer: { ...(printer as any), branchId: derivedBranchId },
        fallbackUsed,
        fallbackChain,
      };
    }

    // No candidate succeeded — determine why
    if (lastCapabilityReason) {
      return { error: "CAPABILITY_MISMATCH", message: lastCapabilityReason };
    }
    if (lastOfflinePrinter) {
      // Offline is preferred over disabled when both occurred: an offline
      // printer may come back on its own, so the caller should retry (503)
      // rather than be told to change configuration.
      return { error: "PRINTER_OFFLINE", message: `All candidate printers offline (last tried ${lastOfflinePrinter})` };
    }
    if (lastDisabledPrinter) {
      return { error: "PRINTER_DISABLED", message: `All candidate printers are disabled (last tried ${lastDisabledPrinter})` };
    }
    if (lastVirtualPrinter) {
      return {
        error: "PRINTER_VIRTUAL",
        message: `All candidate printers are virtual or redirected (last tried ${lastVirtualPrinter}). Register a physical printer on the agent.`,
      };
    }
    if (crossBranchPrinter) {
      // A binding pointed at a printer whose agent lives in another branch (or
      // whose agent/branch chain is broken). This is a data-integrity fault,
      // not "no printer": report it distinctly instead of masking it.
      return {
        error: "CROSS_BRANCH_BINDING",
        message: `Binding(s) in branch ${branchId} reference printer ${crossBranchPrinter}, whose branch (derived via its agent) is different or unresolvable`,
      };
    }
    return { error: "NO_PRINTER_FOUND", message: `No available printer after evaluating ${candidates.length} bindings` };
  } catch (e) {
    // A DB failure here is NOT "no printer found" — mapping it to 404 would
    // hide a real outage as a routing miss and make Odoo treat the job as
    // misconfigured. Report it distinctly; the API layer maps it to 500.
    const message = e instanceof Error ? e.message : "unexpected routing error";
    return { error: "INTERNAL_ERROR", message: `routing failed: ${message}` };
  }
}
