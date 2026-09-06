import { NextResponse } from "next/server";
import { db } from "../../../db";
import { branches } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Gateway branch records are Odoo-owned mirrors.
 *
 * GET is retained for runtime/dashboard visibility.
 * POST is deliberately disabled: branches are created in Odoo and imported
 * through POST /api/odoo/sync. The Gateway Manager only manages runtime
 * resources such as agents and printers.
 */
export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db.select().from(branches).orderBy(desc(branches.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(
    {
      error: "BRANCH_O2O_OWNED",
      message: "Branches are owned by Odoo. Create the branch in Odoo first and synchronize it to the Gateway.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
