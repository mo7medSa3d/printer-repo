import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { destinations } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Destinations are Odoo-owned configuration; Gateway only exposes them read-only here. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const rows = await db.select().from(destinations)
    .where(eq(destinations.branchId, id))
    .orderBy(desc(destinations.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(
    {
      error: "DESTINATION_ODOO_OWNED",
      message: "Destinations are owned by Odoo. Change them in the Odoo Print Gateway module and synchronize the branch.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
