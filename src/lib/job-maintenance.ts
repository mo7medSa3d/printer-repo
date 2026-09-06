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
    SET status = 'expired',
        error = CASE
          WHEN status = 'printing'
            THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)'
          ELSE NULL
        END,
        updated_at = now()
    WHERE status NOT IN ('success', 'failed', 'expired')
      AND expires_at <= now()
      ${agentFilter}
      ${branchFilter}
    RETURNING id, status, error
  `);

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

  // A stale PRINTING lease is an ambiguous physical side effect. Never
  // automatically requeue it: that would permit a different/fresh agent to
  // print the same business document without knowing whether paper already
  // emerged. The operator must explicitly reconcile the UNKNOWN outcome or
  // initiate a new print operation. A late success may still close the
  // original operation through the restricted failed->success path.
  const stalePrinting = await db.execute(sql`
    UPDATE print_jobs
    SET status = 'failed',
        error = CASE
          WHEN expires_at <= now()
            THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)'
          ELSE 'AGENT_EXECUTION_TIMEOUT: agent execution lease expired (physical output is unknown; manual reconciliation required)'
        END,
        updated_at = now()
    WHERE status = 'printing'
      AND updated_at < now() - make_interval(secs => ${STALE_PRINTING_SECONDS})
      ${agentFilter}
      ${branchFilter}
    RETURNING id, error
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
    // Retained in the result contract for compatibility; stale printing is now
    // terminal failed/unknown and is never automatically requeued.
    requeuedPrinting: 0,
    stalePrinting: stalePrinting.rows.length,
    exhaustedClaims: exhaustedClaims.rows.length,
  };
  const unknownExpiryCount = expired.rows.filter((row) => String((row as { error?: unknown }).error ?? "").startsWith("JOB_EXPIRED_DURING_PRINT")).length;
  if (result.expired > 0) incrementMetric("print_jobs_expired_total", result.expired);
  if (unknownExpiryCount > 0) incrementMetric("print_jobs_unknown_total", unknownExpiryCount);
  if (result.requeuedClaims > 0) incrementMetric("print_jobs_requeued_total", result.requeuedClaims);
  if (result.stalePrinting > 0) {
    incrementMetric("print_jobs_failed_total", result.stalePrinting);
    incrementMetric("print_jobs_unknown_total", result.stalePrinting);
  }
  if (result.exhaustedClaims > 0) incrementMetric("print_jobs_failed_total", result.exhaustedClaims);
  return result;
}
