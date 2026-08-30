import { NextResponse } from "next/server";
import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Management read — polling for Desktop Manager. Agent uses /api/agent/jobs with lease semantics.
export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const printerId = url.searchParams.get("printerId");
  const agentId = url.searchParams.get("agentId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

  let q = db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(limit);
  // simple filters — compose where via separate queries for now (small)
  const rows = await q;
  let filtered = rows;
  if (status) filtered = filtered.filter(r => r.status === status);
  if (printerId) filtered = filtered.filter(r => r.printerId === printerId);
  if (agentId) filtered = filtered.filter(r => r.agentId === agentId);
  return NextResponse.json(filtered);
}
