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

export async function resolvePrinterForJob({
  branchId,
  destinationId,
  documentType,
}: {
  branchId: string;
  destinationId: string;
  documentType?: string | null;
}) {
  try {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId) });
    if (!branch) return null;

    const destination = await db.query.destinations.findFirst({
      where: and(eq(destinations.id, destinationId), eq(destinations.branchId, branchId)),
    });
    if (!destination) return null;

    const rows = await db.query.printerBindings.findMany({
      where: and(
        eq(printerBindings.branchId, branchId),
        eq(printerBindings.destinationId, destinationId),
        eq(printerBindings.enabled, true)
      ),
    });

    const winner = selectBestBinding(rows as BindingCandidate[], documentType ?? null);
    if (!winner) return null;

    const printer = await db.query.printers.findFirst({
      where: and(eq(printers.id, winner.printerId), eq(printers.branchId, branchId), eq(printers.enabled, true)),
    });

    if (!printer) return null;

    return {
      branch,
      destination,
      binding: winner,
      printer,
    };
  } catch {
    // Schema not backfilled yet; interface remains backward compatible until the
    // migration is applied in the target deployment.
    return null;
  }
}
