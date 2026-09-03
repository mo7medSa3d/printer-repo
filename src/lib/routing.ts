import { db } from "@/db";
import { agents, branches, destinations, printerBindings, printers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { isVirtualPrinterRecord, type PrinterLike } from "./printer-virtual";
import { getAgentAvailability } from "./agent-availability";

export type BindingCandidate = {
  id: string;
  branchId: string;
  destinationId: string;
  documentType: string | null;
  printerId: string;
  priority: number;
  enabled: boolean;
};

function sortBindingCandidates(bindingRows: BindingCandidate[], requestedDocumentType?: string | null): BindingCandidate[] {
  const normalized = (requestedDocumentType ?? "").trim().toLowerCase();
  return [...bindingRows]
    .filter((binding) => binding.enabled !== false)
    .filter((binding) => {
      const bindingType = (binding.documentType ?? "").trim().toLowerCase();
      return bindingType === "" || bindingType === normalized || normalized === "";
    })
    .sort((a, b) => {
      const aExact = normalized !== "" && (a.documentType ?? "").trim().toLowerCase() === normalized ? 0 : 1;
      const bExact = normalized !== "" && (b.documentType ?? "").trim().toLowerCase() === normalized ? 0 : 1;
      return aExact - bExact || Number(a.priority ?? 0) - Number(b.priority ?? 0) || a.id.localeCompare(b.id);
    });
}

export function selectBestBinding(bindingRows: BindingCandidate[], requestedDocumentType?: string | null) {
  return sortBindingCandidates(bindingRows, requestedDocumentType)[0] ?? null;
}

export function selectFallbackBindings(bindingRows: BindingCandidate[], requestedDocumentType?: string | null): BindingCandidate[] {
  return sortBindingCandidates(bindingRows, requestedDocumentType);
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

  // If the printer explicitly lists supported document kinds, enforce it
  // before evaluating the transport-specific compatibility rules.
  const supported = printer.capabilities?.supported_protocols?.map((s) => s.toLowerCase());
  if (supported && supported.length > 0) {
    if (supported.includes(pt)) return { ok: true };
    if (pt === "raw" || pt === "escpos") {
      if (supported.includes("raw") || supported.includes("escpos") || conn === "spooler" || proto === "spooler") {
        return { ok: true };
      }
      return { ok: false, reason: `CAPABILITY_MISMATCH: payload type ${pt} not in printer supported_protocols [${supported.join(",")}]` };
    }
    return {
      ok: false,
      reason: `CAPABILITY_MISMATCH: payload type ${pt} not in printer supported_protocols [${supported.join(",")}]`,
    };
  }

  // IPP/IPPS can carry PDF or opaque byte streams through Print-Job.
  if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") {
    if (["raw", "escpos", "ipp", "ipps", "pdf"].includes(pt)) return { ok: true };
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
    if (conn === "spooler" || proto === "spooler") return { ok: true };
    if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: pdf payload requires spooler or IPP printer (got ${proto}/${conn})` };
  }
  if (conn === "spooler" || proto === "spooler") return { ok: true };
  if (proto === "ipp" || conn === "ipp" || proto === "ipps" || conn === "ipps") return { ok: true };
  return { ok: false, reason: `CAPABILITY_MISMATCH: payload ${pt} incompatible with printer ${proto}/${conn}` };
}

/** Minimal printer shape the routing availability check needs. */
export interface PrinterAvailability extends PrinterLike {
  lifecycle: string | null;
  status: string | null;
}

export function isPrinterAvailableForJob(printer: PrinterAvailability): boolean {
  if (printer.lifecycle !== "active") return false;
  if (isVirtualPrinterRecord(printer)) return false;
  // Only a positively reported online printer is safe for immediate routing.
  // Unknown telemetry is treated as unavailable rather than risking delivery
  // to a printer whose health state is not known.
  return printer.status === "online";
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
    if (!branch.enabled) return { error: "INVALID_BRANCH", message: `Branch ${branchId} is disabled` };

    const destination = await db.query.destinations.findFirst({
      where: and(eq(destinations.id, destinationId), eq(destinations.branchId, branchId)),
    });
    if (!destination) return { error: "INVALID_DESTINATION", message: `Destination ${destinationId} not found in branch ${branchId}` };
    if (!destination.enabled) return { error: "INVALID_DESTINATION", message: `Destination ${destinationId} is disabled` };

    const rows = await db.query.printerBindings.findMany({
      where: and(
        eq(printerBindings.branchId, branchId),
        eq(printerBindings.destinationId, destinationId),
        eq(printerBindings.enabled, true)
      ),
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
    let crossBranchCandidateSeen = false;

    for (let idx = 0; idx < candidates.length; idx++) {
      const binding = candidates[idx];
      fallbackChain.push(binding.printerId);

      const printer = await db.query.printers.findFirst({
        where: eq(printers.id, binding.printerId),
      });

      if (!printer) continue;

      // Ownership is derived exclusively through Printer -> Agent -> Branch.
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
      if (!agent) {
        return { error: "INTERNAL_ERROR", message: `printer ${printer.id} has no owner agent` };
      }
      // A corrupt cross-branch binding must not prevent a valid fallback
      // printer from serving the same destination. Record it, skip it, and
      // only surface INTERNAL_ERROR when no safe candidate remains.
      if (agent.branchId !== branchId || binding.branchId !== agent.branchId) {
        crossBranchCandidateSeen = true;
        continue;
      }
      if (agent.lifecycle !== "active") continue;
      const availability = getAgentAvailability(agent);
      if (!availability.available) {
        if (["offline", "stale", "missing-heartbeat"].includes(availability.reason)) {
          lastOfflinePrinter = printer.id;
        }
        continue;
      }
      if (isVirtualPrinterRecord(printer)) {
        lastVirtualPrinter = printer.id;
        continue;
      }
      if (printer.lifecycle !== "active") {
        lastDisabledPrinter = printer.id;
        continue;
      }
      if (printer.status !== "online") {
        lastOfflinePrinter = printer.id;
        continue;
      }

      if (payloadType) {
        const cap = validatePayloadForPrinter(payloadType, {
          protocol: printer.protocol,
          connectionType: printer.connectionType,
          capabilities: printer.capabilities,
        });
        if (!cap.ok) {
          lastCapabilityReason = cap.reason;
          continue;
        }
      }

      return {
        branch,
        destination,
        binding,
        printer,
        fallbackUsed: idx > 0,
        fallbackChain,
      };
    }

    if (lastCapabilityReason) return { error: "CAPABILITY_MISMATCH", message: lastCapabilityReason };
    if (lastOfflinePrinter) return { error: "PRINTER_OFFLINE", message: `All candidate printers offline (last tried ${lastOfflinePrinter})` };
    if (lastDisabledPrinter) return { error: "PRINTER_DISABLED", message: `All candidate printers are disabled (last tried ${lastDisabledPrinter})` };
    if (lastVirtualPrinter) {
      return {
        error: "PRINTER_VIRTUAL",
        message: `All candidate printers are virtual or redirected (last tried ${lastVirtualPrinter}). Register a physical printer on the agent.`,
      };
    }
    if (crossBranchCandidateSeen) {
      return { error: "INTERNAL_ERROR", message: "All matching printer bindings reference printers owned by another branch" };
    }
    return { error: "NO_PRINTER_FOUND", message: `No available printer after evaluating ${candidates.length} bindings` };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unexpected routing error";
    return { error: "INTERNAL_ERROR", message: `routing failed: ${message}` };
  }
}
