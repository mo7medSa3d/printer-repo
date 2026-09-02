import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, branches, printers, printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq, count } from "drizzle-orm";
import { z } from "zod";

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
  // Every printer of this agent is in this agent's branch, by construction.
  // The branch is echoed per printer as a DERIVED, read-only value.
  return NextResponse.json({
    agent: safe,
    printers: agentPrinters.map((p) => ({ ...p, branchId: (agent as any).branchId })),
    jobCount: queued?.c ?? 0,
  });
}

const patchAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /**
   * Reassigning an agent to another branch moves ALL of its printers with it —
   * that is the whole point of Branch → Agent → Printer. There is no second
   * place to update, so the move is atomic and can never leave a printer
   * stranded in the old branch.
   */
  branchId: z.string().min(1).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.branchId !== undefined) {
    const branch = await db.query.branches.findFirst({ where: eq(branches.id, parsed.data.branchId) });
    if (!branch) return NextResponse.json({ error: "branchId not found" }, { status: 404 });
    if (branch.enabled === false) return NextResponse.json({ error: "Branch is disabled" }, { status: 409 });
    update.branchId = parsed.data.branchId;
  }

  const [row] = await db.update(agents).set(update as never).where(eq(agents.id, id)).returning({
    id: agents.id,
    branchId: agents.branchId,
    name: agents.name,
    status: agents.status,
  });

  // Report how many printers moved with the agent, so the operator sees the
  // blast radius of the reassignment.
  const [moved] = await db.select({ c: count() }).from(printers).where(eq(printers.agentId, id));
  return NextResponse.json({ agent: row, printersReassigned: moved?.c ?? 0 });
}
