import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, branches } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createAgent } from "@/app/actions";

export const dynamic = "force-dynamic";

const createAgentSchema = z.object({ name: z.string().trim().min(1).max(200), branchId: z.string().trim().min(1).max(120) }).strict();

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const branchId = new URL(req.url).searchParams.get("branchId");
  const rows = await db.select({ id: agents.id, branchId: agents.branchId, name: agents.name, status: agents.status, lifecycle: agents.lifecycle, metadata: agents.metadata, lastSeenAt: agents.lastSeenAt, createdAt: agents.createdAt }).from(agents).where(branchId ? eq(agents.branchId, branchId) : undefined).orderBy(desc(agents.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "name and branchId are required" }, { status: 400 });
  const branch = await db.query.branches.findFirst({ where: eq(branches.id, parsed.data.branchId) });
  if (!branch) return NextResponse.json({ error: "branch not found" }, { status: 404 });
  if (!branch.enabled) return NextResponse.json({ error: "branch is disabled" }, { status: 409 });
  try {
    const result = await createAgent(parsed.data.name, parsed.data.branchId);
    return NextResponse.json(result, { status: 201 });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "unable to create agent" }, { status: 400 }); }
}
