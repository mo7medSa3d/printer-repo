import { NextResponse } from "next/server";
import { db } from "@/db";
import { printerBindings } from "@/db/schema";
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
