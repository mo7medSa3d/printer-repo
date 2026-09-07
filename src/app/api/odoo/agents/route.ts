import { NextResponse } from "next/server";
import { asc, ne } from "drizzle-orm";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      lifecycle: agents.lifecycle,
      lastSeenAt: agents.lastSeenAt,
    })
    .from(agents)
    .where(ne(agents.lifecycle, "retired"))
    .orderBy(asc(agents.name));

  return NextResponse.json({ agents: rows }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
