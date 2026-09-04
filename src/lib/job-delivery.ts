import { db } from "../db";
import { sql } from "drizzle-orm";

/**
 * Ownership rules for handing a job to an agent.
 *
 * The gateway MUST own a job before an agent may execute it:
 *
 *   queued -> claimed -> (delivery to agent) -> printing -> success | failed
 *
 * `claimJobForDelivery` performs the queued->claimed transition inside a
 * single transaction (`SELECT ... FOR UPDATE SKIP LOCKED` + conditional
 * `UPDATE`). Only after that transaction commits may the job be written to a
 * socket, so an agent can never see a still-`queued` job as executable work
 * and can never win the race that produced "printer=SUCCESS / gateway=QUEUED".
 *
 * Two independent recovery paths cover a claim whose delivery is lost:
 *
 *  1. Immediate: `releaseUndeliveredClaim` puts the row straight back to
 *     `queued` when the socket write fails, so the poll path can pick it up
 *     on the next tick. The job id is never recreated.
 *  2. Backstop: the poll endpoint (`GET /api/agent/jobs`) reclaims
 *     `claimed`/`printing` rows that have been silent for
 *     `CLAIM_LEASE_SECONDS`, incrementing `retries`, and permanently fails
 *     them once the retry budget is exhausted.
 *
 * NOTE on the lease: `expires_at` is the business TTL supplied by Odoo and is
 * deliberately NOT overwritten by the claim. The claim lease is
 * `claimed_at + CLAIM_LEASE_SECONDS` (mirrors STALE_CLAIM_SECONDS in
 * `src/app/api/agent/jobs/route.ts`); shortening the caller's TTL to the lease
 * would silently change job expiry semantics.
 */
export const CLAIM_LEASE_SECONDS = 90;

/** How many failed delivery attempts a job tolerates before it is failed. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export type ClaimedJobRow = {
  id: string;
  branchId: string;
  agentId: string;
  printerId: string;
  destinationId: string | null;
  documentType: string | null;
  status: string;
  payload: unknown;
  expiresAt: Date;
  retries: number;
  deliveryAttempts: number;
};

const CLAIM_RETURNING = sql`
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
  print_jobs.delivery_attempts AS "deliveryAttempts"
`;

/**
 * Atomically take ownership of one queued job for `agentId`.
 *
 * Returns the claimed row (status is already `claimed` in the database when
 * this resolves) or null when the job is not claimable: unknown id, wrong
 * agent, already claimed by a concurrent claimer, past its TTL, or locked by
 * another transaction (SKIP LOCKED).
 */
export async function claimJobForDelivery(jobId: string, agentId: string): Promise<ClaimedJobRow | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id FROM print_jobs
      WHERE id = ${jobId}
        AND agent_id = ${agentId}
        AND status = 'queued'
        AND expires_at > now()
      FOR UPDATE SKIP LOCKED
    `);
    if (locked.rows.length === 0) return null;

    const claimed = await tx.execute(sql`
      UPDATE print_jobs
      SET status = 'claimed',
          claimed_at = now(),
          updated_at = now(),
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

/** Records that a claimed job actually left the gateway. */
export async function markJobDelivered(jobId: string, agentId: string): Promise<void> {
  await db.execute(sql`
    UPDATE print_jobs
    SET delivered_at = now(), updated_at = now()
    WHERE id = ${jobId} AND agent_id = ${agentId} AND status IN ('claimed', 'printing')
  `);
}

/**
 * Records the agent's explicit `job_ack`. Acknowledgement means "the agent
 * received the job", never "the job printed". Late ACKs for terminal jobs are
 * rejected so delivery bookkeeping cannot be mutated after the job outcome is
 * already final.
 */
export async function recordJobAck(jobId: string, agentId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE print_jobs
    SET acked_at = COALESCE(acked_at, now()),
        delivered_at = COALESCE(delivered_at, now()),
        updated_at = now()
    WHERE id = ${jobId}
      AND agent_id = ${agentId}
      AND status IN ('claimed', 'printing')
    RETURNING id
  `);
  return res.rows.length > 0;
}

export type ReleaseOutcome = "requeued" | "failed" | "noop";

/**
 * Undo a claim whose delivery never reached the agent.
 *
 * The same job id is reused (never recreated). Once a job has burned through
 * MAX_DELIVERY_ATTEMPTS it is failed with a real error instead of looping
 * forever, so an undeliverable job surfaces in Odoo rather than disappearing.
 */
export async function releaseUndeliveredClaim(jobId: string, agentId: string, reason: string): Promise<ReleaseOutcome> {
  const requeued = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'queued',
        claimed_at = NULL,
        updated_at = now(),
        error = ${reason}
    WHERE id = ${jobId}
      AND agent_id = ${agentId}
      AND status = 'claimed'
      AND delivered_at IS NULL
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
      AND delivered_at IS NULL
      AND delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id
  `);
  if (failed.rows.length > 0) return "failed";

  // Row moved on already (agent reported progress, TTL sweep, poll reclaim).
  return "noop";
}
