import { db } from "@/db";
import { sql } from "drizzle-orm";
import { incrementMetric } from "@/lib/metrics";

export const STALE_CLAIM_SECONDS = 90;
export const STALE_PRINTING_SECONDS = 10 * 60;
export const MAX_RETRIES = 5;

export async function sweepPrintJobs(scope: { agentId?: string; branchId?: string } = {}): Promise<{ expired: number; requeuedClaims: number; stalePrinting: number; exhaustedClaims: number }> {
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

  const stalePrinting = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        error = 'AGENT_EXECUTION_TIMEOUT: agent execution lease expired (agent likely crashed during physical printing)',
        updated_at = now()
    WHERE status = 'printing'
      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})
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
    stalePrinting: stalePrinting.rows.length,
    exhaustedClaims: exhaustedClaims.rows.length,
  };
  if (result.expired > 0) incrementMetric("print_jobs_expired_total", result.expired);
  if (result.requeuedClaims > 0) incrementMetric("print_jobs_requeued_total", result.requeuedClaims);
  if (result.stalePrinting > 0) incrementMetric("print_jobs_failed_total", result.stalePrinting);
  if (result.exhaustedClaims > 0) incrementMetric("print_jobs_failed_total", result.exhaustedClaims);
  return result;
}
