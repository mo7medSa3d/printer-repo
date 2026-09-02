import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { isVirtualPrinterRecord } from "@/lib/printer-virtual";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedBranch = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, requestedBranch);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const filter = requestedBranch ?? odoo.branchId ?? null;
  try {
    const query = db.select({ printer: printers, branchId: agents.branchId }).from(printers).innerJoin(agents, eq(agents.id, printers.agentId)).orderBy(desc(printers.updatedAt));
    const rows = filter ? await query.where(eq(agents.branchId, filter)) : await query;
    return NextResponse.json(rows.filter(({ printer }) => !isVirtualPrinterRecord(printer)).map(({ printer, branchId }) => ({ ...printer, branchId })));
  } catch {
    return NextResponse.json({ error: "database error while listing printers" }, { status: 500 });
  }
}
