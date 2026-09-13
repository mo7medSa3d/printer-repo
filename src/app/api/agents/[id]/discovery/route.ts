import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { agents, discoverySessions } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { validateDiscoveryRequest } from "../../../../../lib/discovery";

export const dynamic = "force-dynamic";

// Discovery is runtime infrastructure only. It never receives or creates Odoo business ownership.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.pair"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  const active = await db.query.discoverySessions.findFirst({ where: and(eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId), eq(discoverySessions.status, "running")) });
  if (active) return NextResponse.json({ error: "Discovery already running for this agent", discoveryId: active.id }, { status: 409 });

  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const v = validateDiscoveryRequest(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const discoveryId = `dsc_${nanoid(12)}`;
  await db.insert(discoverySessions).values({
    id: discoveryId,
    tenantId: claims.tenantId,
    agentId,
    status: "running",
    config: {
      ...(v.cidr ? { cidr: v.cidr } : {}),
      ...((body && typeof body === "object" && !Array.isArray(body)) ? body as Record<string, unknown> : {}),
    },
    stats: {},
    startedAt: new Date(),
  });
  return NextResponse.json({ discoveryId, agentId, status: "running" }, { status: 201 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "agents.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agentId), eq(discoverySessions.tenantId, claims.tenantId)), orderBy: [desc(discoverySessions.createdAt)], limit: 20 });
  return NextResponse.json(rows);
}