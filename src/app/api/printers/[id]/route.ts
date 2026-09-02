import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * Printer branch is NOT patchable: it is derived through the owning agent
 * (printer → agent → branch). To move a printer between branches you either
 * move its agent (PATCH /api/agents/:id) or hand the printer to an agent that
 * is already in the target branch (`agentId` below). `branchId` is rejected
 * outright so a client cannot express an inconsistent state.
 */
const patchSchema = z.object({
  /** Reassign the printer to another agent — this also changes its branch. */
  agentId: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
  type: z.enum(["network", "usb", "spooler", "tcp", "ipp", "ipps"]).optional(),
  connectionType: z.enum(["network", "usb", "spooler", "tcp", "ipp", "ipps"]).optional(),
  printerType: z.enum(["thermal", "laser", "inkjet", "spooler", "other", "unknown"]).optional(),
  protocol: z.enum(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"]).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["online","offline","busy","error","unknown"]).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await db.query.printers.findFirst({ where: eq(printers.id, id), with: { agent: true } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const agent = (row as any).agent as { id: string; branchId: string | null } | null;
  // Derived, read-only branch — the printer row itself stores none.
  return NextResponse.json({ ...row, branchId: agent?.branchId ?? null });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  if ((body as any) && typeof body === "object" && "branchId" in (body as any)) {
    return NextResponse.json(
      {
        error:
          "branchId is not settable on a printer: a printer's branch is derived through its agent (printer → agent → branch). Reassign the agent, or set agentId to an agent in the target branch.",
      },
      { status: 400 }
    );
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.agentId !== undefined && parsed.data.agentId !== existing.agentId) {
    const nextAgent = await db.query.agents.findFirst({ where: eq(agents.id, parsed.data.agentId) });
    if (!nextAgent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });
    if (!(nextAgent as any).branchId) {
      return NextResponse.json({ error: "target agent has no branch; assign it to a branch first" }, { status: 409 });
    }
    // Reassigning the agent intentionally moves the printer's branch with it.
    // That is the single, explicit way a printer changes branch.
    (update as any).agentId = parsed.data.agentId;
  }
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.type !== undefined) update.type = parsed.data.type;
  if (parsed.data.connectionType !== undefined) (update as any).connectionType = parsed.data.connectionType;
  if (parsed.data.printerType !== undefined) (update as any).printerType = parsed.data.printerType;
  if (parsed.data.protocol !== undefined) (update as any).protocol = parsed.data.protocol;
  if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
  if (parsed.data.config !== undefined) update.config = parsed.data.config;
  if (parsed.data.capabilities !== undefined) (update as any).capabilities = parsed.data.capabilities;
  if (parsed.data.status !== undefined) update.status = parsed.data.status;

  const [row] = await db.update(printers).set(update as never).where(eq(printers.id, id)).returning();
  const owner = await db.query.agents.findFirst({ where: eq(agents.id, row.agentId) });
  return NextResponse.json({ ...row, branchId: (owner as any)?.branchId ?? null });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.delete(printers).where(eq(printers.id, id));
  return NextResponse.json({ ok: true });
}
