import { NextResponse } from "next/server";
import { db } from "@/db";
import { destinations, printerBindings } from "@/db/schema";
import { assertPrinterInBranch, loadPrinterWithBranch } from "@/lib/printer-branch";
import { validateManager } from "@/lib/manager-auth";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const rows = await db.select().from(printerBindings)
    .where(eq(printerBindings.branchId, id))
    .orderBy(desc(printerBindings.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { destinationId?: unknown; documentType?: unknown; printerId?: unknown; priority?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  const destinationId = typeof body.destinationId === "string" && body.destinationId.trim() ? body.destinationId.trim() : null;
  const documentType = typeof body.documentType === "string" && body.documentType.trim() ? body.documentType.trim() : null;
  const printerId = typeof body.printerId === "string" && body.printerId.trim() ? body.printerId.trim() : null;
  if (!destinationId || !printerId) {
    return NextResponse.json({ error: "destinationId and printerId are required" }, { status: 400 });
  }

  // Branch isolation: destination must belong to this branch
  const dest = await db.query.destinations.findFirst({ where: eq(destinations.id, destinationId) });
  if (!dest) return NextResponse.json({ error: "INVALID_DESTINATION: destination not found" }, { status: 404 });
  if (dest.branchId !== id) {
    return NextResponse.json({ error: "INVALID_DESTINATION: destination belongs to another branch" }, { status: 400 });
  }
  // `printer_bindings.branch_id` STAYS: a binding is a branch-scoped routing
  // rule (branch + destination + document type → printer), and the routing
  // index (branch_id, destination_id, document_type, priority) is the primary
  // lookup path for every print request. It is routing scope, not printer
  // ownership. It must, however, agree with the printer's real owner, which is
  // derived as printer → agent → branch.
  const loaded = await loadPrinterWithBranch(printerId);
  if (!loaded.ok) {
    if (loaded.error === "PRINTER_NOT_FOUND") {
      return NextResponse.json({ error: "NO_PRINTER_FOUND: printer not found" }, { status: 404 });
    }
    return NextResponse.json({ error: loaded.message }, { status: 409 });
  }
  const consistent = assertPrinterInBranch(loaded.printer.branchId, id, printerId);
  if (!consistent.ok) {
    return NextResponse.json(
      { error: `Cross-branch binding refused: ${consistent.message}` },
      { status: 400 }
    );
  }

  const bindingId = `binding_${nanoid(8)}`;
  await db.insert(printerBindings).values({
    id: bindingId,
    branchId: id,
    destinationId,
    documentType,
    printerId,
    priority: typeof body.priority === "number" ? body.priority : 1,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
  });

  return NextResponse.json({ id: bindingId, branchId: id, destinationId, documentType, printerId }, { status: 201 });
}
