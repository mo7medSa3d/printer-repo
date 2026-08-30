import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq, count } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const agentPrinters = await db.query.printers.findMany({ where: eq(printers.agentId, id) });
  const [queued] = await db.select({ c: count() }).from(printJobs).where(eq(printJobs.agentId, id));
  // strip secret
  const { secret: _secret, pairingCode: _pc, pairingCodeExpiresAt: _exp, ...safe } = agent as Record<string, unknown> & { secret?: unknown; pairingCode?: unknown; pairingCodeExpiresAt?: unknown };
  return NextResponse.json({ agent: safe, printers: agentPrinters.map(p => ({ ...p })), jobCount: queued?.c ?? 0 });
}
