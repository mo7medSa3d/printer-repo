import { NextResponse } from "next/server";
import { db } from "../../../db";
import { printJobs } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { isJobStatus } from "../../../lib/job-status";

export const dynamic = "force-dynamic";

const TERMINAL_JOB_STATUSES = ["success", "failed", "expired"] as const;
const MAX_CLEANUP_ROWS = 5000;
const MAX_LIST_ROWS = 200;

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const printerId = url.searchParams.get("printerId");
  const agentId = url.searchParams.get("agentId");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), MAX_LIST_ROWS);

  if (status && !isJobStatus(status)) {
    return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
  }

  const conditions = [
    ...(status ? [eq(printJobs.status, status)] : []),
    ...(printerId ? [eq(printJobs.printerId, printerId)] : []),
    ...(agentId ? [eq(printJobs.agentId, agentId)] : []),
  ];

  const rows = await db
    .select({
      id: printJobs.id,
      branchId: printJobs.branchId,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      destinationId: printJobs.destinationId,
      documentType: printJobs.documentType,
      status: printJobs.status,
      error: printJobs.error,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
    })
    .from(printJobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit);
  return NextResponse.json(rows);
}

export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const confirm = url.searchParams.get("confirm");

  if (confirm !== "1") {
    return NextResponse.json({ error: "Cleanup requires confirm=1" }, { status: 400 });
  }
  if (!beforeRaw) {
    return NextResponse.json({ error: "Cleanup requires before=<ISO-8601 timestamp>" }, { status: 400 });
  }

  const before = new Date(beforeRaw);
  if (Number.isNaN(before.getTime())) {
    return NextResponse.json({ error: "before must be a valid ISO-8601 timestamp" }, { status: 400 });
  }
  if (before.getTime() > Date.now()) {
    return NextResponse.json({ error: "before cannot be in the future" }, { status: 400 });
  }

  const requestedLimit = limitRaw === null ? MAX_CLEANUP_ROWS : Number(limitRaw);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_CLEANUP_ROWS) {
    return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_CLEANUP_ROWS}` }, { status: 400 });
  }

  const deleted = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: printJobs.id })
      .from(printJobs)
      .where(
        and(
          inArray(printJobs.status, [...TERMINAL_JOB_STATUSES]),
          lt(printJobs.createdAt, before),
        )
      )
      .orderBy(printJobs.createdAt)
      .limit(requestedLimit);

    if (candidates.length === 0) return 0;

    const result = await tx
      .delete(printJobs)
      .where(inArray(printJobs.id, candidates.map((row) => row.id)));
    return result.rowCount ?? 0;
  });

  return NextResponse.json({ deleted, before: before.toISOString(), limit: requestedLimit });
}
