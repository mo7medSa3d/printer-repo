import { NextResponse } from "next/server";
import { db } from "../../../../../../db";
import { agents, discoverySessions, discoveredDevices } from "../../../../../../db/schema";
import { validateManager } from "../../../../../../lib/manager-auth";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; discoveryId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: agentId, discoveryId } = await params;
  const session = await db.query.discoverySessions.findFirst({ where: and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agentId)) });
  if (!session) return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  const devices = await db.query.discoveredDevices.findMany({ where: eq(discoveredDevices.discoveryId, discoveryId) });
  return NextResponse.json({ session, devices });
}
