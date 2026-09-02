import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers, printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { canTransitionLifecycle } from "@/lib/lifecycle";
import { eq, count, desc } from "drizzle-orm";
import { z } from "zod";
import { generatePairingCode } from "@/lib/agent-auth";

export const dynamic = "force-dynamic";
const patchSchema = z.object({ lifecycle: z.enum(["active", "disabled", "retired"]) }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const agentPrinters = await db.query.printers.findMany({ where: eq(printers.agentId, id), orderBy: [desc(printers.createdAt)] });
  const [jobs] = await db.select({ c: count() }).from(printJobs).where(eq(printJobs.agentId, id));
  const { secret: _secret, pairingCode: _pc, pairingCodeExpiresAt: _exp, ...safe } = agent as Record<string, unknown>;
  return NextResponse.json({ agent: safe, printers: agentPrinters, jobCount: jobs?.c ?? 0 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: unknown; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "lifecycle is required" }, { status: 400 });
  const next = parsed.data.lifecycle;
  if (!canTransitionLifecycle(agent.lifecycle, next)) return NextResponse.json({ error: `invalid lifecycle transition: ${agent.lifecycle} -> ${next}` }, { status: 409 });
  const now = new Date();
  const reenable = agent.lifecycle === "disabled" && next === "active";
  const pairingCode = reenable ? generatePairingCode() : null;
  await db.transaction(async (tx) => {
    await tx.update(agents).set({ lifecycle: next, secret: null, pairingCode, pairingCodeExpiresAt: pairingCode ? new Date(now.getTime() + 30 * 60 * 1000) : null, status: "offline", updatedAt: now }).where(eq(agents.id, id));
    if (next !== "active") {
      await tx.update(printers).set({ lifecycle: "disabled", updatedAt: now }).where(eq(printers.agentId, id));
    }
  });
  return NextResponse.json({ ok: true, lifecycle: next, pairingCode });
}
