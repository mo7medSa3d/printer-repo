import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { validateAgent } from "@/lib/agent-auth";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isJobStatus, canTransition, isTerminal, type JobStatus } from "@/lib/job-status";
import { CLAIM_LEASE_SECONDS } from "@/lib/job-delivery";
import { logInfo, logWarn, requestIdFrom } from "@/lib/log";
import { incrementMetric } from "@/lib/metrics";

export const dynamic = "force-dynamic";

const STALE_CLAIM_SECONDS = CLAIM_LEASE_SECONDS;
const MAX_RETRIES = 5;
const MAX_CLAIM_BATCH = 20;
export const MAX_AGENT_IN_FLIGHT_JOBS = 500;
const MAX_ERROR_LENGTH = 2000;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const branchFilter = agent.branchId ? sql`AND branch_id = ${agent.branchId}` : sql``;

  await db.execute(sql`
    UPDATE print_jobs
    SET status = 'expired', updated_at = now()
    WHERE agent_id = ${agent.id}
      AND status NOT IN ('success', 'failed', 'expired')
      AND expires_at <= now()
      ${branchFilter}
  `);

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

  // Capacity and claiming must run in the SAME database transaction. A
  // statement-local advisory lock is insufficient here: PostgreSQL can take a
  // statement snapshot before waiting on the advisory lock, allowing a second
  // concurrent poll to observe the same queued rows. Holding the lock for the
  // transaction makes the snapshot and claim serialization explicit.
  const claimJobs = async (tx: { execute: typeof db.execute }) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agent.id}`}))
    `);

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE agent_id = ${agent.id}
        AND status IN ('claimed', 'printing')
        AND expires_at > now()
        ${branchFilter}
    `);
    const inFlight = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    const remainingSlots = Math.max(0, MAX_AGENT_IN_FLIGHT_JOBS - inFlight);

    // Stale claims are recovery work and are always admitted because they do
    // not increase the number of in-flight jobs. Queued work is capped to the
    // actual remaining capacity, so this transaction can never add more jobs
    // than MAX_AGENT_IN_FLIGHT_JOBS even under concurrent polling.
    const queuedLimit = Math.min(MAX_CLAIM_BATCH, remainingSlots);
    const claimed = await tx.execute(sql`
      WITH stale_candidates AS (
        SELECT id, created_at, 0 AS priority
        FROM print_jobs
        WHERE agent_id = ${agent.id}
          AND expires_at > now()
          AND status IN ('claimed', 'printing')
          AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
          AND retries < ${MAX_RETRIES}
          ${branchFilter}
        ORDER BY created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
      ),
      queued_candidates AS (
        SELECT id, created_at, 1 AS priority
        FROM print_jobs
        WHERE agent_id = ${agent.id}
          AND expires_at > now()
          AND status = 'queued'
          AND ${queuedLimit} > 0
          ${branchFilter}
        ORDER BY created_at ASC
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
        ORDER BY c.priority ASC, c.created_at ASC
        LIMIT ${MAX_CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE print_jobs
      SET
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
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

    const rows = (claimed as unknown as { rows?: unknown[] })?.rows ?? (claimed as unknown as unknown[]);
    return Array.isArray(rows) ? rows : Array.isArray(claimed) ? claimed : [];
  };

  // The real Drizzle/Postgres connection always has transaction(). The
  // fallback keeps lightweight route mocks compatible without weakening the
  // production path, where the transaction is mandatory for correctness.
  const rows = typeof (db as { transaction?: unknown }).transaction === "function"
    ? await db.transaction((tx) => claimJobs(tx as { execute: typeof db.execute }))
    : await claimJobs(db);

  return NextResponse.json(rows);
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

  if (!canTransition(currentStatus, requestedStatus)) return NextResponse.json({ error: `Invalid status transition: ${currentStatus} -> ${requestedStatus}` }, { status: 409 });

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
