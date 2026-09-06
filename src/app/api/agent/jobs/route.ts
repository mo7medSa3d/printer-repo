import { db } from "../../../../db";
import { printJobs } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, isLateSuccessAllowed, derivePhysicalOutcome, type JobStatus } from "../../../../lib/job-status";
import { logInfo, logWarn, requestIdFrom } from "../../../../lib/log";
import { incrementMetric } from "../../../../lib/metrics";
import { sweepPrintJobs, STALE_CLAIM_SECONDS, MAX_RETRIES } from "../../../../lib/job-maintenance";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

export const dynamic = "force-dynamic";
const MAX_CLAIM_BATCH = 20;
export const MAX_AGENT_IN_FLIGHT_JOBS = 500;
const MAX_ERROR_LENGTH = 2000;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await sweepPrintJobs({ agentId: agent.id, branchId: agent.branchId });

  const branchFilter = agent.branchId ? sql`AND p.branch_id = ${agent.branchId}` : sql``;
  const claimJobs = async (tx: { execute: typeof db.execute }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agent.id}`}))`);

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id
      JOIN printers pr ON pr.id = p.printer_id
      JOIN branches b ON b.id = p.branch_id
      WHERE p.agent_id = ${agent.id}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND b.enabled = true
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND pr.lifecycle = 'active'
        AND pr.status = 'online'
        ${branchFilter}
    `);
    const inFlight = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    const remainingSlots = Math.max(0, MAX_AGENT_IN_FLIGHT_JOBS - inFlight);
    const queuedLimit = Math.min(MAX_CLAIM_BATCH, remainingSlots);

    const claimed = await tx.execute(sql`
      WITH stale_candidates AS (
        SELECT p.id, p.created_at, 0 AS priority
        FROM print_jobs p
        JOIN agents a ON a.id = p.agent_id
        JOIN printers pr ON pr.id = p.printer_id
        JOIN branches b ON b.id = p.branch_id
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'claimed'
          AND p.updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
          AND p.retries < ${MAX_RETRIES}
          AND b.enabled = true
          AND a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
          ${branchFilter}
        ORDER BY p.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
      ),
      queued_candidates AS (
        SELECT p.id, p.created_at, 1 AS priority
        FROM print_jobs p
        JOIN agents a ON a.id = p.agent_id
        JOIN printers pr ON pr.id = p.printer_id
        JOIN branches b ON b.id = p.branch_id
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'queued'
          AND ${queuedLimit} > 0
          AND b.enabled = true
          AND a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
          ${branchFilter}
        ORDER BY p.created_at ASC
        LIMIT ${queuedLimit}
      ),
      candidate_ids AS (
        SELECT id, created_at, priority FROM stale_candidates
        UNION ALL
        SELECT id, created_at, priority FROM queued_candidates
      ),
      claimable AS (
        SELECT p.id
        FROM print_jobs p
        JOIN candidate_ids c ON c.id = p.id
        JOIN agents a ON a.id = p.agent_id
        JOIN printers pr ON pr.id = p.printer_id
        JOIN branches b ON b.id = p.branch_id
        WHERE b.enabled = true
          AND a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
        ORDER BY c.priority ASC, c.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
        FOR UPDATE OF p, a, pr, b SKIP LOCKED
      )
      UPDATE print_jobs
      SET
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        delivered_at = NULL,
        acked_at = NULL,
        delivery_attempts = print_jobs.delivery_attempts + 1,
        retries = CASE WHEN print_jobs.status = 'claimed'
                       THEN print_jobs.retries + 1
                       ELSE print_jobs.retries END
      FROM claimable
      WHERE print_jobs.id = claimable.id
      RETURNING
        print_jobs.id AS id,
        print_jobs.branch_id AS "branchId",
        print_jobs.agent_id AS "agentId",
        print_jobs.printer_id AS "printerId",
        print_jobs.destination_id AS "destinationId",
        print_jobs.document_type AS "documentType",
        print_jobs.status AS status,
        print_jobs.payload AS payload,
        print_jobs.expires_at AS "expiresAt",
        print_jobs.retries AS retries,
        print_jobs.error AS error
    `);

    const rows = (claimed as unknown as { rows?: unknown[] })?.rows ?? (claimed as unknown as unknown[]);
    return Array.isArray(rows) ? rows : Array.isArray(claimed) ? claimed : [];
  };

  const rows = typeof (db as { transaction?: unknown }).transaction === "function"
    ? await db.transaction((tx) => claimJobs(tx as { execute: typeof db.execute }))
    : await claimJobs(db);

  return NextResponse.json((rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    physicalOutcome: derivePhysicalOutcome(String(row.status ?? ""), typeof row.error === "string" ? row.error : null),
  })));
}

export async function PATCH(req: Request) {
  const requestId = requestIdFrom(req);
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) {
    logWarn("job.status.unauthorized", { requestId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: { jobId?: unknown; status?: unknown; error?: unknown; reason?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { jobId, status: requestedStatus, error: rawError, reason: rawReason } = body;
  if (typeof jobId !== "string" || !jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!isJobStatus(requestedStatus)) return NextResponse.json({ error: "status must be a valid job status" }, { status: 400 });
  const errorMessage = typeof rawError === "string" && rawError.length > 0 ? rawError.slice(0, MAX_ERROR_LENGTH) : null;
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";

  const whereClause = agent.branchId
    ? and(eq(printJobs.id, jobId), eq(printJobs.agentId, agent.id), eq(printJobs.branchId, agent.branchId))
    : and(eq(printJobs.id, jobId), eq(printJobs.agentId, agent.id));
  const job = await db.query.printJobs.findFirst({ where: whereClause });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const currentStatus = job.status as JobStatus;

  if (!isTerminal(currentStatus) && new Date(job.expiresAt).getTime() <= Date.now()) {
    const expiryError = currentStatus === "printing"
      ? "JOB_EXPIRED_DURING_PRINT: physical output is unknown"
      : null;
    const expired = await db.update(printJobs)
      .set({ status: "expired", error: expiryError, updatedAt: new Date() })
      .where(and(whereClause, eq(printJobs.status, currentStatus)))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (expired.length === 1) {
      incrementMetric("print_jobs_expired_total");
      if (expiryError) incrementMetric("print_jobs_unknown_total");
      logInfo("print.job.expired", { requestId, jobId, agentId: agent.id, physicalOutcome: expiryError ? "unknown" : "not_printed" });
      return NextResponse.json({
        error: "Job has expired",
        status: "expired",
        physicalOutcome: derivePhysicalOutcome("expired", expiryError),
      }, { status: 409 });
    }
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Job transition raced with another update${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  // --- Agent rejection: hand a claimed job back to the queue.
  if (requestedStatus === "queued" && currentStatus === "claimed") {
    if (reason !== "pending_full") {
      return NextResponse.json({ error: "Invalid status transition: claimed -> queued requires reason 'pending_full'" }, { status: 409 });
    }
    const updated = await db.update(printJobs)
      .set({ status: "queued", error: null, updatedAt: new Date() })
      .where(and(whereClause, eq(printJobs.status, "claimed")))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (updated.length !== 1) {
      const winner = await db.query.printJobs.findFirst({ where: whereClause });
      const winnerStatus = winner?.status as JobStatus | undefined;
      return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
    }
    incrementMetric("print_jobs_rejected_total");
    logInfo("print.job.rejected", { requestId, jobId, agentId: agent.id, physicalOutcome: "not_printed" });
    return NextResponse.json({ success: true, status: "queued", physicalOutcome: "not_printed" });
  }

  // --- Late physical-outcome override: failed -> success.
  let lateSuccess = false;
  if (currentStatus === "failed" && requestedStatus === "success") {
    if (!isLateSuccessAllowed({ status: currentStatus, error: job.error, updatedAt: job.updatedAt }, Date.now())) {
      return NextResponse.json({ error: "Invalid status transition: failed -> success (late success not allowed for this job)" }, { status: 409 });
    }
    lateSuccess = true;
  }

  if (!canTransition(currentStatus, requestedStatus)) return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });

  const nextError = lateSuccess ? `LATE_SUCCESS: ${job.error ?? "AGENT_EXECUTION_TIMEOUT"}` : errorMessage;
  const updated = await db.update(printJobs)
    .set({
      status: requestedStatus,
      error: nextError,
      updatedAt: new Date(),
      ...(requestedStatus === "claimed" ? { claimedAt: new Date() } : {}),
    })
    .where(and(whereClause, eq(printJobs.status, currentStatus)))
    .returning({ status: printJobs.status, error: printJobs.error });

  if (updated.length !== 1) {
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  const physicalOutcome = derivePhysicalOutcome(requestedStatus, nextError);
  incrementMetric(`print_jobs_${requestedStatus}_total`);
  if (physicalOutcome === "unknown") incrementMetric("print_jobs_unknown_total");
  if (lateSuccess) {
    incrementMetric("print_jobs_late_success_total");
    logInfo("print.job.late_success", { requestId, jobId, agentId: agent.id, physicalOutcome });
  }
  logInfo(`print.job.${requestedStatus}`, { requestId, jobId, agentId: agent.id, physicalOutcome });
  return NextResponse.json({ success: true, status: requestedStatus, physicalOutcome });
}
