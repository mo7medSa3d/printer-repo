import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Management read — requires manager session (cookie or Bearer). Never exposes agent.secret.
export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // `branchId` is the agent's OWN column and the single source of branch truth
  // for everything it owns: Branch → Agent → Printer.
  const rows = await db.select({
    id: agents.id,
    branchId: agents.branchId,
    name: agents.name,
    status: agents.status,
    metadata: agents.metadata,
    lastSeenAt: agents.lastSeenAt,
    createdAt: agents.createdAt,
  }).from(agents).orderBy(desc(agents.createdAt));

  return NextResponse.json(rows);
}
