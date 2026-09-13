import { NextResponse } from "next/server";
import { db } from "../../../../../../db";
import { agents, discoverySessions, discoveredDevices } from "../../../../../../db/schema";
import { validateManager } from "../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../lib/authorization";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; discoveryId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId, discoveryId } = await params;
  const session = await db.query.discoverySessions.findFirst({ where: and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)) });
  if (!session) return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  const devices = await db.query.discoveredDevices.findMany({ where: and(eq(discoveredDevices.discoveryId, discoveryId), eq(discoveredDevices.tenantId, claims.tenantId)) });
  return NextResponse.json({ session, devices });
}
