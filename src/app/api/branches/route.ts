import { NextResponse } from "next/server";
import { db } from "../../../db";
import { branches } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Gateway branch records are Odoo-owned mirrors. */
export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db.select().from(branches).orderBy(desc(branches.createdAt));
  return NextResponse.json(rows);
}

/**
 * Branch creation is intentionally unavailable in Gateway.
 * Create the company/branch in Odoo, then let POST /api/odoo/sync import it.
 */
export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(
    {
      error: "BRANCH_ODOO_OWNED",
      message: "Branches are owned by Odoo. Create the branch in Odoo first and synchronize it to the Gateway.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
