import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const branchId = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, branchId);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const filter = branchId ?? odoo.branchId ?? null;
  try {
    const rows = filter
      ? await db.select({
          id: agents.id,
          branchId: agents.branchId,
          name: agents.name,
          status: agents.status,
          lifecycle: agents.lifecycle,
          lastSeenAt: agents.lastSeenAt,
          createdAt: agents.createdAt,
        }).from(agents).where(eq(agents.branchId, filter)).orderBy(desc(agents.lastSeenAt))
      : await db.select({
          id: agents.id,
          branchId: agents.branchId,
          name: agents.name,
          status: agents.status,
          lifecycle: agents.lifecycle,
          lastSeenAt: agents.lastSeenAt,
          createdAt: agents.createdAt,
        }).from(agents).orderBy(desc(agents.lastSeenAt));
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json({ error: "database error while listing agents" }, { status: 500 });
  }
}
