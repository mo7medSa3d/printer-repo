import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, printers, printJobs } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { eq, count, desc, and } from "drizzle-orm";
import { z } from "zod";
import { transitionAgentLifecycle, LifecycleConflict } from "../../../../lib/agent-lifecycle";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const patchSchema = z.object({ lifecycle: z.enum(["active", "disabled", "retired"]) }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, id), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const agentPrinters = await db.query.printers.findMany({ where: and(eq(printers.agentId, id), eq(printers.tenantId, claims.tenantId)), orderBy: [desc(printers.createdAt)] });
  const [jobs] = await db.select({ c: count() }).from(printJobs).where(and(eq(printJobs.agentId, id), eq(printJobs.tenantId, claims.tenantId)));
  const { secret: _secret, pairingCodeHash: _pch, pairingCode: _pc, pairingCodeExpiresAt: _exp, ...safe } = agent as Record<string, unknown>;
  return NextResponse.json({ agent: safe, printers: agentPrinters, jobCount: jobs?.c ?? 0 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "lifecycle is required" }, { status: 400 });
  const { lifecycle } = parsed.data;
  try {
    const result = await transitionAgentLifecycle(id, lifecycle, claims.tenantId);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, lifecycle: result.lifecycle, pairingCode: result.pairingCode });
  } catch (error) {
    if (error instanceof LifecycleConflict) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError("agent.lifecycle_failed", { agentId: id, error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
