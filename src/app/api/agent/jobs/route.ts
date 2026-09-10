import { db } from "../../../../db";
import { printJobs } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, isLateSuccessAllowed, derivePhysicalOutcome, AGENT_REQUEUE_REASONS, type JobStatus } from "../../../../lib/job-status";
import { logInfo, logWarn, requestIdFrom } from "../../../../lib/log";
import { incrementMetric } from "../../../../lib/metrics";
import { sweepPrintJobs, STALE_CLAIM_SECONDS, MAX_RETRIES } from "../../../../lib/job-maintenance";
import { CLAIM_RETURNING, MAX_DELIVERY_ATTEMPTS, MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../lib/job-delivery";
import { fencedJobWrite } from "../../../../lib/job-fencing";
import { hasBodyOverLimit } from "../../../../lib/request-limits";

export const dynamic = "force-dynamic";
const MAX_CLAIM_BATCH = 20;
const MAX_ERROR_LENGTH = 2000;

/**
 * Poll claim. Two candidate classes, both fenced by the delivery boundary
 * and BOTH attempt budgets (delivery_attempts < MAX_DELIVERY_ATTEMPTS and
 * retries < MAX_RETRIES) — a reclaim that increments delivery_attempts must
 * respect the same ceiling as the WS-claim and queued-poll paths:
 *
 *  1. Stale claims that were NEVER delivered (no delivered_at, no ack):
 *     provably pre-dispatch, safe to re-deliver under a fresh claim token.
 *  2. Queued jobs not yet claimed.
 *
 * A claim whose lease expired AFTER delivery is deliberately absent here: the
 * delivery sweep fails those with an unknown-outcome marker instead, because
 * re-delivering could print a document twice.
 *
 * claimed != delivered: the poll claim does NOT stamp delivered_at. Committing
 * a row is not proof the HTTP response reached the agent; delivery evidence
 * is stamped only when the agent demonstrably holds the job (WebSocket send +
 * fenced mark, fenced job_ack, or a fenced status report on the claim).
 */
export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await sweepPrintJobs({ agentId: agent.id });

  const claimJobs = async (tx: { execute: typeof db.execute }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agent.id}`}))`);

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id
      JOIN printers pr ON pr.id = p.printer_id
      WHERE p.agent_id = ${agent.id}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND pr.lifecycle = 'active'
        AND pr.status = 'online'
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
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'claimed'
          AND p.delivered_at IS NULL
          AND p.acked_at IS NULL
          AND p.updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
          AND p.retries < ${MAX_RETRIES}
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
        ORDER BY p.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
      ),
      queued_candidates AS (
        SELECT p.id, p.created_at, 1 AS priority
        FROM print_jobs p
        JOIN agents a ON a.id = p.agent_id
        JOIN printers pr ON pr.id = p.printer_id
        WHERE p.agent_id = ${agent.id}
          AND p.expires_at > now()
          AND p.status = 'queued'
          AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND p.retries < ${MAX_RETRIES}
          AND ${queuedLimit} > 0
          AND a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
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
        WHERE a.lifecycle = 'active'
          AND a.status = 'online'
          AND pr.lifecycle = 'active'
          AND pr.status = 'online'
        ORDER BY c.priority ASC, c.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
        FOR UPDATE OF p, a, pr SKIP LOCKED
      )
      UPDATE print_jobs
      SET
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        claim_token = gen_random_uuid()::text,
        acked_at = NULL,
        delivery_attempts = print_jobs.delivery_attempts + 1,
        retries = CASE WHEN print_jobs.status = 'claimed'
                       THEN print_jobs.retries + 1
                       ELSE print_jobs.retries END
      FROM claimable
      WHERE print_jobs.id = claimable.id
      RETURNING ${CLAIM_RETURNING}
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

  let body: { jobId?: unknown; status?: unknown; error?: unknown; reason?: unknown; claimToken?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { jobId, status: requestedStatus, error: rawError, reason: rawReason, claimToken: rawClaimToken } = body;
  if (typeof jobId !== "string" || !jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!isJobStatus(requestedStatus)) return NextResponse.json({ error: "status must be a valid job status" }, { status: 400 });
  const errorMessage = typeof rawError === "string" && rawError.length > 0 ? rawError.slice(0, MAX_ERROR_LENGTH) : null;
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  const claimToken = typeof rawClaimToken === "string" && rawClaimToken.length > 0 && rawClaimToken.length <= 120 ? rawClaimToken : null;

  const whereClause = and(eq(printJobs.id, jobId), eq(printJobs.agentId, agent.id));
  const job = await db.query.printJobs.findFirst({ where: whereClause });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const currentStatus = job.status as JobStatus;

  // Advisory in-memory pre-check for a clean 409 STALE_CLAIM response. It is
  // NOT the security boundary: every lifecycle UPDATE below repeats the
  // token inside its WHERE predicate (fencedJobWrite), so a token that
  // changes between this read and the write matches zero rows atomically.
  if (job.claimToken && claimToken !== job.claimToken) {
    logWarn("job.status.stale_claim", { requestId, jobId, agentId: agent.id });
    return NextResponse.json({ error: "Stale claim token: this attempt was superseded by a newer claim", code: "STALE_CLAIM", status: currentStatus }, { status: 409 });
  }

  if (!isTerminal(currentStatus) && new Date(job.expiresAt).getTime() <= Date.now()) {
    const delivered = Boolean(job.deliveredAt || job.ackedAt);
    const expiryError = currentStatus === "printing"
      ? "JOB_EXPIRED_DURING_PRINT: physical output is unknown"
      : delivered && currentStatus === "claimed"
        ? "UNKNOWN_PARTIAL_DELIVERY: job expired after delivery without an execution report"
        : null;
    const expired = await db.update(printJobs)
      // Delivery evidence only when the expired row was actually held
      // (claimed/printing): a queued row that merely timed out was never
      // possessed by any agent, so stamping it would fabricate evidence.
      .set({ status: "expired", error: expiryError, updatedAt: new Date(), deliveredAt: sql`CASE WHEN ${printJobs.status} IN ('claimed', 'printing') THEN COALESCE(${printJobs.deliveredAt}, now()) ELSE ${printJobs.deliveredAt} END` })
      .where(fencedJobWrite(jobId, agent.id, currentStatus, claimToken))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (expired.length === 1) {
      incrementMetric("print_jobs_expired_total");
      if (expiryError) incrementMetric("print_jobs_unknown_total");
      logInfo("print.job.expired", { requestId, jobId, agentId: agent.id, physicalOutcome: expiryError ? "unknown" : "not_printed" });
      return NextResponse.json({ error: "Job has expired", status: "expired", physicalOutcome: derivePhysicalOutcome("expired", expiryError) }, { status: 409 });
    }
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Job transition raced with another update${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  if (requestedStatus === "queued" && currentStatus === "claimed") {
    if (!AGENT_REQUEUE_REASONS.includes(reason as (typeof AGENT_REQUEUE_REASONS)[number])) {
      return NextResponse.json({ error: "Invalid status transition: claimed -> queued requires an explicit pre-execution rejection reason" }, { status: 409 });
    }
    const updated = await db.update(printJobs)
      // A fenced pre-execution return proves nothing was dispatched, so the
      // row must carry NO attempt-specific delivery evidence afterwards:
      // token, delivered_at, acked_at and claimed_at are all cleared.
      //
      // Counter semantics (LAW 9): a rejection is NOT a physical delivery
      // attempt - zero bytes were sent - so the claim's delivery-attempt
      // charge is refunded. It DOES consume the retry budget (one bounded
      // hand-back per rejection) so a saturated or misbehaving agent cannot
      // loop a job through claim/reject forever; once retries are spent the
      // claim gates below refuse further delivery and the job terminalizes
      // by TTL expiry, never by a burned delivery budget.
      .set({
        status: "queued",
        claimToken: null,
        deliveredAt: null,
        ackedAt: null,
        claimedAt: null,
        error: `Agent returned job before execution (${reason})`,
        updatedAt: new Date(),
        deliveryAttempts: sql`GREATEST(${printJobs.deliveryAttempts} - 1, 0)`,
        retries: sql`${printJobs.retries} + 1`,
      })
      .where(fencedJobWrite(jobId, agent.id, currentStatus, claimToken))
      .returning({ status: printJobs.status, error: printJobs.error });
    if (updated.length !== 1) {
      const winner = await db.query.printJobs.findFirst({ where: whereClause });
      const winnerStatus = winner?.status as JobStatus | undefined;
      return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
    }
    incrementMetric("print_jobs_rejected_total");
    logInfo("print.job.rejected", { requestId, jobId, agentId: agent.id, reason, physicalOutcome: "not_printed" });
    return NextResponse.json({ success: true, status: "queued", physicalOutcome: "not_printed" });
  }

  let lateSuccess = false;
  if (currentStatus === "failed" && requestedStatus === "success") {
    if (!isLateSuccessAllowed({ status: currentStatus, error: job.error, updatedAt: job.updatedAt }, Date.now())) {
      return NextResponse.json({ error: "Invalid status transition: failed -> success (late success not allowed for this job)" }, { status: 409 });
    }
    lateSuccess = true;
  }

  if (!canTransition(currentStatus, requestedStatus, { allowLateSuccess: lateSuccess })) {
    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });
  }

  const nextError = lateSuccess ? `LATE_SUCCESS: ${job.error ?? "AGENT_EXECUTION_TIMEOUT"}` : errorMessage;
  // The authoritative write: id + agent + observed status + CLAIM TOKEN, all
  // inside the UPDATE predicate. A stale worker whose claim was reclaimed
  // (new token) matches zero rows here even if it passed the advisory read
  // above - this is the TOCTOU-proof fence, not the in-memory compare.
  //
  // A fenced report on a claimed/printing row also proves the agent holds
  // this delivery attempt, so delivered_at is stamped (without overwriting
  // earlier evidence). claimed != delivered: only agent-observed possession
  // - never the server's own claim commit - creates delivery evidence.
  const updated = await db.update(printJobs)
    .set({
      status: requestedStatus,
      error: nextError,
      updatedAt: new Date(),
      deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`,
    })
    .where(fencedJobWrite(jobId, agent.id, currentStatus, claimToken))
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
