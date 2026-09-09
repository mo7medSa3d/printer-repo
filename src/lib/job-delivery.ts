import { db } from "../db";
import { printJobs } from "../db/schema";
import { sql } from "drizzle-orm";
import { fencedDeliveryWrite } from "./job-fencing";
import { STALE_CLAIM_SECONDS } from "./job-maintenance";

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
 * concurrent agents from claiming the same job. The delivery-attempt budget is
 * enforced HERE so no path can claim a job past its attempt ceiling.
 */
export async function claimJobForDelivery(jobId: string, agentId: string): Promise<ClaimedJobRow | null> {
  return db.transaction(async (tx) => {
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

export async function markJobDelivered(jobId: string, agentId: string, claimToken: string | null): Promise<void> {
  // Fenced to THIS claim (the token returned by claimJobForDelivery): a
  // superseded delivery attempt can never stamp evidence onto the row of
  // the claim that replaced it.
  await db.update(printJobs)
    .set({ deliveredAt: new Date(), updatedAt: new Date() })
    .where(fencedDeliveryWrite(jobId, agentId, claimToken, ["claimed", "printing"]));
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
