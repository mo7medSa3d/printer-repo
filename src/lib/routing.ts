import { db } from "@/db";
import { branches, destinations, printerBindings, printers } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export type BindingCandidate = {
  id: string;
  branchId: string;
  destinationId: string;
  documentType: string | null;
  printerId: string;
  priority: number;
  enabled: boolean;
};

export function selectBestBinding(bindingRows: BindingCandidate[], requestedDocumentType?: string | null) {
  const normalized = (requestedDocumentType ?? "").trim().toLowerCase();

  const candidates = [...bindingRows]
    .filter((binding) => binding.enabled !== false)
    .filter((binding) => {
      const bindingType = (binding.documentType ?? "").trim().toLowerCase();
      return bindingType === "" || bindingType === normalized || normalized === "";
    })
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0));

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
    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0));
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

  // If printer explicitly lists supported protocols, enforce it strictly
  const supported = printer.capabilities?.supported_protocols?.map((s) => s.toLowerCase());
  if (supported && supported.length > 0) {
    if (!supported.includes(pt) && !supported.includes("raw") && !(pt === "escpos" && supported.includes("escpos"))) {
      // spooler is a special case: it can handle raw/escpos via RAW spooler mode
      if (!(conn === "spooler" && (pt === "raw" || pt === "escpos"))) {
        return { ok: false, reason: `CAPABILITY_MISMATCH: payload type ${pt} not in printer supported_protocols [${supported.join(",")}]` };
      }
    }
    return { ok: true };
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

export function isPrinterAvailableForJob(printer: { enabled: boolean | null; status: string | null }): boolean {
  if (printer.enabled === false) return false;
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
  | "PRINTER_OFFLINE"
  | "CAPABILITY_MISMATCH";

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
    let lastCapabilityReason: string | null = null;

    for (let idx = 0; idx < candidates.length; idx++) {
      const binding = candidates[idx];
      fallbackChain.push(binding.printerId);

      const printer = await db.query.printers.findFirst({
        where: eq(printers.id, binding.printerId),
      });

      if (!printer) {
        // Printer record missing — try next fallback
        continue;
      }

      // Branch consistency: printer must belong to same branch
      if (printer.branchId && printer.branchId !== branchId) {
        // This binding violates isolation — skip and continue fallback
        continue;
      }

      // Enabled check
      if (printer.enabled === false) {
        if (idx === 0) lastOfflinePrinter = printer.id;
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

      // Agent branch consistency: ensure printer's agent is in same branch
      try {
        const agents = await import("@/db/schema").then((m) => m.agents);
        const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
        if (agent && agent.branchId && agent.branchId !== branchId) {
          continue; // cross-branch printer binding invalid
        }
      } catch {}

      const fallbackUsed = idx > 0;
      // Auditable: include fallbackChain
      return {
        branch,
        destination,
        binding,
        printer,
        fallbackUsed,
        fallbackChain,
      };
    }

    // No candidate succeeded — determine why
    if (lastCapabilityReason) {
      return { error: "CAPABILITY_MISMATCH", message: lastCapabilityReason };
    }
    if (lastOfflinePrinter) {
      return { error: "PRINTER_OFFLINE", message: `All candidate printers offline (last tried ${lastOfflinePrinter})` };
    }
    return { error: "NO_PRINTER_FOUND", message: `No available printer after evaluating ${candidates.length} bindings` };
  } catch (e) {
    // Schema not backfilled yet; interface remains backward compatible until the
    // migration is applied in the target deployment.
    return null;
  }
}
