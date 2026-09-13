import { NextResponse } from "next/server";
import { db } from "../../../db";
import { printJobs } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  isJobFilterStatus,
  derivePhysicalOutcome,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
} from "../../../lib/job-status";

export const dynamic = "force-dynamic";

const TERMINAL_JOB_STATUSES = ["success", "failed", "expired"] as const;
const MAX_CLEANUP_ROWS = 5000;

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status")?.trim().toLowerCase();
  const searchParam = (url.searchParams.get("search") ?? url.searchParams.get("q"))?.trim();
  const printerId = url.searchParams.get("printerId");
  const agentId = url.searchParams.get("agentId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);

  if (statusParam && !isJobFilterStatus(statusParam)) {
    return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
  }

  const conditions = [eq(printJobs.tenantId, claims.tenantId)];

  if (statusParam && statusParam !== "all") {
    if (statusParam === "active" || statusParam === "in_flight") {
      conditions.push(inArray(printJobs.status, ["queued", "claimed", "printing"]));
    } else if (statusParam === "queued" || statusParam === "claimed" || statusParam === "printing" || statusParam === "expired") {
      conditions.push(eq(printJobs.status, statusParam));
    } else if (statusParam === "success" || statusParam === "printed") {
      conditions.push(eq(printJobs.status, "success"));
    } else if (statusParam === "unknown" || statusParam === "attention") {
      conditions.push(
        // Non-null: PHYSICAL_OUTCOME_UNKNOWN_MARKERS is a non-empty tuple, so or() always receives >= 1 clause.
        or(...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`${printJobs.error} LIKE ${m + "%"}`))!
      );
    } else if (statusParam === "failed") {
      conditions.push(
        // Non-null: and() always receives the fixed eq() clause plus the marker clauses.
        and(
          eq(printJobs.status, "failed"),
          ...PHYSICAL_OUTCOME_UNKNOWN_MARKERS.map((m) => sql`COALESCE(${printJobs.error}, '') NOT LIKE ${m + "%"}`)
        )!
      );
    } else if (statusParam === "unassigned") {
      conditions.push(
        // Non-null: or() always receives four fixed clauses (drizzle types
        // the result SQL|undefined regardless of arity).
        or(
          eq(printJobs.destination, "unassigned"),
          eq(printJobs.printerId, "unassigned"),
          sql`${printJobs.printerId} NOT IN (SELECT id FROM printers WHERE lifecycle = 'active')`,
          sql`${printJobs.agentId} NOT IN (SELECT id FROM agents WHERE lifecycle = 'active')`
        )!
      );
    }
  }

  if (printerId) conditions.push(eq(printJobs.printerId, printerId));
  if (agentId) conditions.push(eq(printJobs.agentId, agentId));

  if (searchParam) {
    const term = `%${searchParam.toLowerCase()}%`;
    conditions.push(
      // Non-null: or() always receives six fixed LIKE clauses.
      or(
        sql`LOWER(${printJobs.id}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.destination}, '')) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.documentType}, '')) LIKE ${term}`,
        sql`LOWER(${printJobs.printerId}) LIKE ${term}`,
        sql`LOWER(${printJobs.agentId}) LIKE ${term}`,
        sql`LOWER(COALESCE(${printJobs.error}, '')) LIKE ${term}`
      )!
    );
  }

  const rows = await db
    .select({
      id: printJobs.id,
      destination: printJobs.destination,
      documentType: printJobs.documentType,
      agentId: printJobs.agentId,
      printerId: printJobs.printerId,
      status: printJobs.status,
      error: printJobs.error,
      requestedBy: printJobs.requestedBy,
      idempotencyKey: printJobs.idempotencyKey,
      retries: printJobs.retries,
      deliveryAttempts: printJobs.deliveryAttempts,
      claimedAt: printJobs.claimedAt,
      deliveredAt: printJobs.deliveredAt,
      ackedAt: printJobs.ackedAt,
      expiresAt: printJobs.expiresAt,
      createdAt: printJobs.createdAt,
      updatedAt: printJobs.updatedAt,
    })
    .from(printJobs)
    .where(conditions.length ? and(...conditions)! : undefined)
    .orderBy(desc(printJobs.createdAt))
    .limit(limit)
    .offset(offset);
  // physicalOutcome is part of the job truth contract (shared with
  // derivePhysicalOutcome on the agent protocol): "failed" alone must never be
  // shown as "definitely not printed" when an unknown-outcome marker proves
  // the printer may have received the job.
  return NextResponse.json(rows.map((row) => ({ ...row, physicalOutcome: derivePhysicalOutcome(row.status, row.error) })));
}

export async function DELETE(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const confirm = url.searchParams.get("confirm");
  if (confirm !== "1") return NextResponse.json({ error: "Cleanup requires confirm=1" }, { status: 400 });
  if (!beforeRaw) return NextResponse.json({ error: "Cleanup requires before=<ISO-8601 timestamp>" }, { status: 400 });

  const before = new Date(beforeRaw);
  if (Number.isNaN(before.getTime())) return NextResponse.json({ error: "before must be a valid ISO-8601 timestamp" }, { status: 400 });
  if (before.getTime() > Date.now()) return NextResponse.json({ error: "before cannot be in the future" }, { status: 400 });

  const requestedLimit = limitRaw === null ? MAX_CLEANUP_ROWS : Number(limitRaw);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_CLEANUP_ROWS) {
    return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_CLEANUP_ROWS}` }, { status: 400 });
  }

  const deleted = await db.transaction(async (tx) => {
    const candidates = await tx.select({ id: printJobs.id }).from(printJobs).where(
      and(eq(printJobs.tenantId, claims.tenantId), inArray(printJobs.status, [...TERMINAL_JOB_STATUSES]), lt(printJobs.createdAt, before)),
    ).orderBy(printJobs.createdAt).limit(requestedLimit);
    if (candidates.length === 0) return 0;
    const result = await tx.delete(printJobs).where(and(eq(printJobs.tenantId, claims.tenantId), inArray(printJobs.id, candidates.map((row) => row.id))));
    return result.rowCount ?? 0;
  });
  return NextResponse.json({ deleted, before: before.toISOString(), limit: requestedLimit });
}