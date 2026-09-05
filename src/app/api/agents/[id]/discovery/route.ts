import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { agents, discoverySessions } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { validateDiscoveryRequest } from "../../../../../lib/discovery";

export const dynamic = "force-dynamic";

// POST /api/agents/[id]/discovery — manager starts discovery for one agent (branch-scoped)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  // Rate limit: one active per agent
  const active = await db.query.discoverySessions.findFirst({ where: and(eq(discoverySessions.agentId, agentId), eq(discoverySessions.status, "running")) });
  if (active) return NextResponse.json({ error: "Discovery already running for this agent", discoveryId: active.id }, { status: 409 });
  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const v = validateDiscoveryRequest(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const id = `dsc_${nanoid(12)}`;
  await db.insert(discoverySessions).values({
    id, agentId, branchId: agent.branchId, status: "running", config: body as any, stats: {}, startedAt: new Date(),
  });
  return NextResponse.json({ discoveryId: id, agentId, branchId: agent.branchId, status: "running" }, { status: 201 });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: agentId } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const rows = await db.query.discoverySessions.findMany({ where: eq(discoverySessions.agentId, agentId), orderBy: [desc(discoverySessions.createdAt)], limit: 20 });
  return NextResponse.json(rows);
}
