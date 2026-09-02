import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, type JobStatus } from "@/lib/job-status";
import { CLAIM_LEASE_SECONDS } from "@/lib/job-delivery";
import { logInfo, logWarn, requestIdFrom } from "@/lib/log";
import { incrementMetric } from "@/lib/metrics";

// A claimed/printing job that hasn't been updated in this long is assumed
// to belong to a crashed or disconnected agent and becomes reclaimable.
// This is also the lease the WS claim-before-delivery path relies on
// (src/lib/job-delivery.ts) — the two must stay identical.
const STALE_CLAIM_SECONDS = CLAIM_LEASE_SECONDS;
// After this many reclaims, stop retrying and mark the job permanently failed.
const MAX_RETRIES = 5;
// Cap how many jobs one poll can claim at once (basic resource limit).
const MAX_CLAIM_BATCH = 20;
const MAX_ERROR_LENGTH = 2000;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 1. TTL sweep, scoped to this agent: anything past its deadline that
  //    hasn't reached a terminal state is expired before we do anything else.
  // Optional branch restriction fragment: when agents are scoped to a branch
  // ensure queries only touch jobs that belong to the same branch. This keeps
  // behavior compatible with pre-migration installs where agent.branchId may be null.
  const branchFilter = agent.branchId ? sql`AND branch_id = ${agent.branchId}` : sql``;

  await db.execute(sql`
    UPDATE print_jobs
    SET status = 'expired', updated_at = now()
    WHERE agent_id = ${agent.id}
      AND status NOT IN ('success', 'failed', 'expired')
      AND expires_at <= now()
      ${branchFilter}
  `);

  // 2. Give up on stale claims that have exhausted their retry budget -
  //    the agent that held them is presumed gone for good.
  await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        error = 'exceeded max retries after a stale claim (agent likely crashed or lost connection)',
        updated_at = now()
    WHERE agent_id = ${agent.id}
      AND status IN ('claimed', 'printing')
      AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
      AND retries >= ${MAX_RETRIES}
      ${branchFilter}
  `);

  // 3. Atomically claim: fresh queued jobs, plus stale claimed/printing
  //    jobs still within their retry budget (agent crash recovery).
  //    FOR UPDATE SKIP LOCKED + a single UPDATE...RETURNING is what makes
  //    this safe under concurrent pollers/agents - two pollers can never
  //    walk away with the same job id.
  const claimed = await db.execute(sql`
    WITH claimable AS (
      SELECT id FROM print_jobs
      WHERE agent_id = ${agent.id}
        AND expires_at > now()
        AND (
          status = 'queued'
          OR (
            status IN ('claimed', 'printing')
            AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
            AND retries < ${MAX_RETRIES}
          )
        )
        ${branchFilter}
      ORDER BY created_at ASC
      LIMIT ${MAX_CLAIM_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs
    SET
      status = 'claimed',
      claimed_at = now(),
      updated_at = now(),
      -- The HTTP response IS the delivery for the poll path, so the claim and
      -- the delivery record commit together (the WS path records them
      -- separately: claim first, delivery only once the socket accepted it).
      delivered_at = now(),
      acked_at = NULL,
      delivery_attempts = print_jobs.delivery_attempts + 1,
      retries = CASE WHEN print_jobs.status IN ('claimed', 'printing')
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
      print_jobs.retries AS retries
  `);

  // Every row returned here is already 'claimed' in the database: the agent
  // never receives a job it does not own. drizzle node-postgres returns
  // { rows, rowCount } but callers expect a plain array; normalize defensively.
  const rows = (claimed as unknown as { rows?: unknown[] })?.rows ?? (claimed as unknown as unknown[]);
  return NextResponse.json(Array.isArray(rows) ? rows : Array.isArray(claimed) ? claimed : []);
}

export async function PATCH(req: Request) {
  const requestId = requestIdFrom(req);
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) {
    logWarn("job.status.unauthorized", { requestId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { jobId?: unknown; status?: unknown; error?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { jobId, status: requestedStatus, error: rawError } = body;
  if (typeof jobId !== "string" || !jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  if (!isJobStatus(requestedStatus)) return NextResponse.json({ error: "status must be a valid job status" }, { status: 400 });
  const errorMessage = typeof rawError === "string" && rawError.length > 0 ? rawError.slice(0, MAX_ERROR_LENGTH) : null;

  const whereClause = agent.branchId
    ? and(eq(printJobs.id, jobId), eq(printJobs.agentId, agent.id), eq(printJobs.branchId, agent.branchId))
    : and(eq(printJobs.id, jobId), eq(printJobs.agentId, agent.id));
  const job = await db.query.printJobs.findFirst({ where: whereClause });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const currentStatus = job.status as JobStatus;

  // Expiration is itself an atomic compare-and-set. If another request wins
  // the race, this update affects zero rows and we re-read the winner.
  if (!isTerminal(currentStatus) && new Date(job.expiresAt).getTime() <= Date.now()) {
    const expired = await db.update(printJobs)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(whereClause, eq(printJobs.status, currentStatus)))
      .returning({ status: printJobs.status });
    if (expired.length === 1) {
      incrementMetric("print_jobs_expired_total");
      logInfo("print.job.expired", { requestId, jobId, agentId: agent.id });
      return NextResponse.json({ error: "Job has expired", status: "expired" }, { status: 409 });
    }
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Job transition raced with another update${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  if (!canTransition(currentStatus, requestedStatus)) {
    return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });
  }

  // Atomic compare-and-set: the status observed above is part of the UPDATE
  // predicate. Exactly one conflicting concurrent transition can therefore win.
  const updated = await db.update(printJobs)
    .set({ status: requestedStatus, error: errorMessage, updatedAt: new Date() })
    .where(and(whereClause, eq(printJobs.status, currentStatus)))
    .returning({ status: printJobs.status });

  if (updated.length !== 1) {
    const winner = await db.query.printJobs.findFirst({ where: whereClause });
    const winnerStatus = winner?.status as JobStatus | undefined;
    return NextResponse.json({ error: `Concurrent status transition rejected${winnerStatus ? `; current status is ${winnerStatus}` : ""}`, status: winnerStatus ?? "unknown" }, { status: 409 });
  }

  incrementMetric(`print_jobs_${requestedStatus}_total`);
  logInfo(`print.job.${requestedStatus}`, { requestId, jobId, agentId: agent.id });
  return NextResponse.json({ success: true, status: requestedStatus });
}
