import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Gateway -> Odoo printer status visibility (idempotent, branch-scoped)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const branchId = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, branchId);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const filter = branchId ?? odoo.branchId ?? null;
  try {
    const rows = filter
      ? await db.select().from(printers).where(eq(printers.branchId, filter)).orderBy(desc(printers.updatedAt))
      : await db.select().from(printers).orderBy(desc(printers.updatedAt));
    return NextResponse.json(rows);
  } catch {
    const rows = await db.select().from(printers).orderBy(desc(printers.updatedAt));
    return NextResponse.json(rows);
  }
}
