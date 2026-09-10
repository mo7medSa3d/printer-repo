import { db } from "../db";
import { printJobs } from "../db/schema";
import { sql } from "drizzle-orm";
import { fencedDeliveryWrite } from "./job-fencing";
import { STALE_CLAIM_SECONDS, MAX_RETRIES } from "./job-maintenance";

/**
 * Hard ceiling on live (claimed + printing, unexpired) jobs per agent.
 * Defined HERE - the claim-ownership home - and imported by the creation
 * admission check (print-job-service) and the poll batch sizer
 * (agent/jobs route), so the three sites can never diverge.
 */
export const MAX_AGENT_IN_FLIGHT_JOBS = 500;

/**
 * Ownership rules for handing a job to an agent.
 *
 * The Gateway owns runtime delivery state. A queued job is eligible only when
 * its owning agent and runtime printer are still active and online at the
 * delivery boundary. Odoo business entities are intentionally not part of
 * this transaction.
 *
 * Every claim mints a fresh `claim_token` (see migration 0024). Agents must
 * echo it on status updates so a stale worker — an attempt whose lease
 * expired and was reclaimed — is rejected by a DB-enforced ownership
 * predicate, not by an in-memory convention.
 *
 * COUNTER CONTRACT (single coherent definition, proven by ws-claim-delivery
 * and job-maintenance tests):
 *   delivery_attempts = hand-off ATTEMPTS: every claim that resulted in the
 *     job leaving the Gateway toward an agent (WebSocket frame sent or poll
 *     response returned). A release after a failed/unevidenced hand-off
 *     KEEPS the charge (the frame may have reached the agent — ambiguity is
 *     budget-bound, never retried freely). A fenced pre-execution rejection
 *     (pending_full / agent_shutting_down / ledger_unavailable) REFUNDS it:
 *     the agent provably transmitted zero bytes, so burning the physical
 *     budget would let a saturated agent expire healthy jobs (LAW 9).
 *   retries = safe returns to 'queued': pre-execution rejections, stale-claim
 *     re-deliveries, and sweep requeues. Bounds hand-back loops independently
 *     of the delivery ceiling.
 * Both ceilings gate BOTH claim paths (WS `claimJobForDelivery` and the poll
 * stale/queued candidates); no path may claim past either.
 */
export const CLAIM_LEASE_SECONDS = STALE_CLAIM_SECONDS;
export const MAX_DELIVERY_ATTEMPTS = 5;

export type ClaimedJobRow = {
  id: string;
  agentId: string;
  printerId: string;
  documentType: string | null;
  status: string;
  payload: unknown;
  expiresAt: Date;
  retries: number;
  deliveryAttempts: number;
  claimToken: string | null;
  error?: string | null;
};

export const CLAIM_RETURNING = sql`
  print_jobs.id AS id,
  print_jobs.agent_id AS "agentId",
  print_jobs.printer_id AS "printerId",
  print_jobs.document_type AS "documentType",
  print_jobs.status AS status,
  print_jobs.payload AS payload,
  print_jobs.expires_at AS "expiresAt",
  print_jobs.retries AS retries,
  print_jobs.delivery_attempts AS "deliveryAttempts",
  print_jobs.claim_token AS "claimToken",
  print_jobs.error AS error
`;

/**
 * Atomically take ownership of one queued job for `agentId`.
 *
 * Eligibility is checked again at the delivery boundary while the runtime
 * owner rows are locked. PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern keeps
 * concurrent agents from claiming the same job. BOTH attempt budgets are
 * enforced HERE so no path can claim a job past its ceilings:
 * `delivery_attempts` bounds real hand-offs to the agent, `retries` bounds
 * safe returns to the queue (pre-execution rejections and stale-claim
 * re-deliveries refund/consume the RETRY budget, never the delivery budget -
 * zero bytes transmitted must not exhaust the physical-delivery allowance).
 */
export async function claimJobForDelivery(jobId: string, agentId: string): Promise<ClaimedJobRow | null> {
  return db.transaction(async (tx) => {
    // Same advisory lock the poll claim path and the creation admission
    // check take: concurrent WS pushes and polls for one agent serialize
    // here, so the in-flight ceiling below is a true invariant, not a
    // best-effort pre-check that racing claims could overshoot.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print_jobs:agent:${agentId}`}))`);
    const live = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id
      JOIN printers pr ON pr.id = p.printer_id
      WHERE p.agent_id = ${agentId}
        AND p.status IN ('claimed', 'printing')
        AND p.expires_at > now()
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND pr.lifecycle = 'active'
        AND pr.status = 'online'
    `);
    const inFlight = Number((live.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    // The WS push path previously had no ceiling at all: a NOTIFY fan-out or
    // bulk creation could push live jobs past MAX while the poll path and
    // creation admission both refused. Refuse here instead of claiming into
    // an overloaded agent; the job stays queued for a later poll.
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) return null;
    const locked = await tx.execute(sql`
      SELECT p.id
      FROM print_jobs p
      JOIN agents a ON a.id = p.agent_id
      JOIN printers pr ON pr.id = p.printer_id
      WHERE p.id = ${jobId}
        AND p.agent_id = ${agentId}
        AND p.status = 'queued'
        AND p.expires_at > now()
        AND p.delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
        AND p.retries < ${MAX_RETRIES}
        AND a.lifecycle = 'active'
        AND a.status = 'online'
        AND pr.lifecycle = 'active'
        AND pr.status = 'online'
      FOR UPDATE OF p, a, pr SKIP LOCKED
    `);
    if (locked.rows.length === 0) return null;

    const claimed = await tx.execute(sql`
      UPDATE print_jobs
      SET status = 'claimed',
          claimed_at = now(),
          updated_at = now(),
          claim_token = gen_random_uuid()::text,
          delivered_at = NULL,
          acked_at = NULL,
          delivery_attempts = print_jobs.delivery_attempts + 1
      WHERE id = ${jobId}
        AND agent_id = ${agentId}
        AND status = 'queued'
        AND expires_at > now()
      RETURNING ${CLAIM_RETURNING}
    `);
    return (claimed.rows[0] as ClaimedJobRow | undefined) ?? null;
  });
}

export async function markJobDelivered(jobId: string, agentId: string, claimToken: string | null): Promise<boolean> {
  // Fenced to THIS claim (the token returned by claimJobForDelivery): a
  // superseded delivery attempt can never stamp evidence onto the row of
  // the claim that replaced it. Returns whether the evidence write landed:
  // callers must NOT report "delivered" on a socket success alone - only a
  // persisted, same-token delivered_at counts as delivery.
  const res = await db.update(printJobs)
    .set({ deliveredAt: new Date(), updatedAt: new Date() })
    .where(fencedDeliveryWrite(jobId, agentId, claimToken, ["claimed", "printing"]))
    .returning({ id: printJobs.id });
  return res.length > 0;
}

export async function recordJobAck(jobId: string, agentId: string, claimToken?: string | null): Promise<boolean> {
  const res = await db.update(printJobs)
    .set({ ackedAt: sql`COALESCE(${printJobs.ackedAt}, now())`, deliveredAt: sql`COALESCE(${printJobs.deliveredAt}, now())`, updatedAt: new Date() })
    .where(fencedDeliveryWrite(jobId, agentId, claimToken, ["claimed", "printing"]))
    .returning({ id: printJobs.id });
  return res.length > 0;
}

export type ReleaseOutcome = "requeued" | "failed" | "noop";

export async function releaseUndeliveredClaim(jobId: string, agentId: string, claimToken: string | null, reason: string): Promise<ReleaseOutcome> {
  // Fenced by the claim token of the delivery attempt being released: if a
  // concurrent reclaim already produced a newer claim, neither UPDATE may
  // match it. The status='claimed' predicate alone would be re-claimable
  // (a poll claim re-sets status to 'claimed' with a new token).
  const requeued = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'queued',
        claimed_at = NULL,
        claim_token = NULL,
        updated_at = now(),
        error = ${reason}
    WHERE id = ${jobId}
      AND agent_id = ${agentId}
      AND status = 'claimed'
      AND claim_token IS NOT DISTINCT FROM ${claimToken}
      AND delivered_at IS NULL
      AND acked_at IS NULL
      AND delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id
  `);
  if (requeued.rows.length > 0) return "requeued";

  const failed = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        updated_at = now(),
        error = ${`${reason} (giving up after ${MAX_DELIVERY_ATTEMPTS} delivery attempts)`}
    WHERE id = ${jobId}
      AND agent_id = ${agentId}
      AND status = 'claimed'
      AND claim_token IS NOT DISTINCT FROM ${claimToken}
      AND delivered_at IS NULL
      AND acked_at IS NULL
      AND delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id
  `);
  if (failed.rows.length > 0) return "failed";

  return "noop";
}
