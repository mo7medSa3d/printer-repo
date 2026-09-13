import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { discoverySessions } from "../../../../../../../db/schema";
import { validateManager } from "../../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../../lib/authorization";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; discoveryId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.disable"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId, discoveryId } = await params;
  const session = await db.query.discoverySessions.findFirst({ where: and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)) });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.status !== "running") return NextResponse.json({ error: `Already ${session.status}` }, { status: 409 });
  await db.update(discoverySessions).set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)));
  return NextResponse.json({ ok: true, status: "cancelled" });
}
