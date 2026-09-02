import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { isVirtualPrinterRecord } from "@/lib/printer-virtual";
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
    // Branch scoping walks branch → agents → printers. There is no
    // printers.branch_id: the agent join IS the branch filter, so a
    // branch-scoped Odoo key can never see another branch's hardware even if
    // a stale Odoo mirror claims otherwise.
    const base = db
      .select({ printer: printers, branchId: agents.branchId, agentName: agents.name })
      .from(printers)
      .innerJoin(agents, eq(printers.agentId, agents.id));
    const joined = filter
      ? await base.where(eq(agents.branchId, filter)).orderBy(desc(printers.updatedAt))
      : await base.orderBy(desc(printers.updatedAt));
    // `branchId` in the response is DERIVED from the owning agent and is
    // informational/read-only for the Odoo mirror.
    const rows = joined.map((r) => ({ ...r.printer, branchId: r.branchId, agentName: r.agentName }));
    // Odoo picks print targets from this list: a virtual or redirected queue
    // must never be offered as an available printer.
    return NextResponse.json(rows.filter((r) => !isVirtualPrinterRecord(r)));
  } catch (e) {
    // Never fall back to all rows: an unscoped dump would leak printers that
    // belong to other branches to a branch-scoped key holder.
    return NextResponse.json({ error: "database error while listing printers" }, { status: 500 });
  }
}
