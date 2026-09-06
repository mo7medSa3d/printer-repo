import { db } from "../db";
import { sql } from "drizzle-orm";
import { incrementMetric } from "./metrics";

export const STALE_CLAIM_SECONDS = 90;
export const STALE_PRINTING_SECONDS = 10 * 60;
export const MAX_RETRIES = 5;

export async function sweepPrintJobs(scope: { agentId?: string; branchId?: string } = {}): Promise<{ expired: number; requeuedClaims: number; requeuedPrinting: number; stalePrinting: number; exhaustedClaims: number }> {
  const agentFilter = scope.agentId ? sql`AND agent_id = ${scope.agentId}` : sql``;
  const branchFilter = scope.branchId ? sql`AND branch_id = ${scope.branchId}` : sql``;

  const expired = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'expired', updated_at = now()
    WHERE status NOT IN ('success', 'failed', 'expired')
      AND expires_at <= now()
      ${agentFilter}
      ${branchFilter}
    RETURNING id
  `);

  // A stale claim means delivery ownership was acquired but the agent never
  // advanced the job to PRINTING. Requeue it for the same agent so a temporarily
  // lost WebSocket/poll cycle can recover without requiring the agent to remain
  // alive at the exact moment the lease expires. Each recovery increments
  // retries; once the retry budget is exhausted the job is failed explicitly.
  const requeuedClaims = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'queued',
        claimed_at = NULL,
        delivered_at = NULL,
        acked_at = NULL,
        retries = retries + 1,
        updated_at = now()
    WHERE status = 'claimed'
      AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
      AND retries < ${MAX_RETRIES}
      AND expires_at > now()
      ${agentFilter}
      ${branchFilter}
    RETURNING id
  `);

  // A stale PRINTING lease means the agent stopped reporting while the
  // document was at the printer. The physical outcome is unknown, so we do
  // NOT guess a terminal state: the job goes back to the queue and the
  // (restarted) owner applies its crash-recovery policy —
  // agent.reprint_after_crash=true reprints it (at-least-once), =false
  // refuses and reports a terminal failure. A restarted agent keeps its
  // lease fresh via heartbeat keep-alive, so a legitimately long print is
  // never touched. Only an exhausted retry budget (or a lapsed business TTL)
  // fails the job outright here.
  const requeuedPrinting = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'queued',
        claimed_at = NULL,
        delivered_at = NULL,
        acked_at = NULL,
        error = 'AGENT_RESTART_DURING_PRINT: agent stopped during physical print; requeued for the agent crash-recovery policy (reprint_after_crash)',
        retries = retries + 1,
        updated_at = now()
    WHERE status = 'printing'
      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})
      AND retries < ${MAX_RETRIES}
      AND expires_at > now()
      ${agentFilter}
      ${branchFilter}
    RETURNING id
  `);

  const stalePrinting = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        error = 'AGENT_EXECUTION_TIMEOUT: agent execution lease expired (agent likely crashed during physical printing; retry budget exhausted)',
        updated_at = now()
    WHERE status = 'printing'
      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})
      AND (retries >= ${MAX_RETRIES} OR expires_at <= now())
      ${agentFilter}
      ${branchFilter}
    RETURNING id
  `);

  const exhaustedClaims = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        error = 'exceeded max retries after a stale claim (agent likely crashed or lost connection)',
        updated_at = now()
    WHERE status = 'claimed'
      AND updated_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
      AND retries >= ${MAX_RETRIES}
      ${agentFilter}
      ${branchFilter}
    RETURNING id
  `);

  const result = {
    expired: expired.rows.length,
    requeuedClaims: requeuedClaims.rows.length,
    requeuedPrinting: requeuedPrinting.rows.length,
    stalePrinting: stalePrinting.rows.length,
    exhaustedClaims: exhaustedClaims.rows.length,
  };
  if (result.expired > 0) incrementMetric("print_jobs_expired_total", result.expired);
  if (result.requeuedClaims > 0) incrementMetric("print_jobs_requeued_total", result.requeuedClaims);
  if (result.requeuedPrinting > 0) incrementMetric("print_jobs_restart_requeued_total", result.requeuedPrinting);
  if (result.stalePrinting > 0) incrementMetric("print_jobs_failed_total", result.stalePrinting);
  if (result.exhaustedClaims > 0) incrementMetric("print_jobs_failed_total", result.exhaustedClaims);
  return result;
}
