import { NextResponse } from "next/server";
import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import { isJobStatus } from "@/lib/job-status";

export const dynamic = "force-dynamic";

const TERMINAL_JOB_STATUSES = ["success", "failed", "expired"] as const;

// Management read — polling for Desktop Manager. Agent uses /api/agent/jobs with lease semantics.
export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const printerId = url.searchParams.get("printerId");
  const agentId = url.searchParams.get("agentId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

  if (status && !isJobStatus(status)) {
    return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
  }

  const conditions = [
    ...(status ? [eq(printJobs.status, status)] : []),
    ...(printerId ? [eq(printJobs.printerId, printerId)] : []),
    ...(agentId ? [eq(printJobs.agentId, agentId)] : []),
  ];

  const rows = await db
    .select()
    .from(printJobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit);
  return NextResponse.json(rows);
}

// Management maintenance — remove only terminal Gateway history. Active work
// remains untouched so cleanup can never delete queued/claimed/printing jobs.
export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await db
    .delete(printJobs)
    .where(inArray(printJobs.status, [...TERMINAL_JOB_STATUSES]));

  return NextResponse.json({ deleted: result.rowCount ?? 0 });
}
