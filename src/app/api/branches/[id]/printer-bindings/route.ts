import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printerBindings } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Printer bindings are Odoo-owned routing configuration; Gateway exposes read-only visibility. */
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
  return NextResponse.json(
    {
      error: "BINDING_ODOO_OWNED",
      message: "Printer bindings are owned by Odoo. Configure routing in the Odoo Print Gateway module and synchronize the branch.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
