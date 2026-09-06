import { db } from "../db";
import { sql } from "drizzle-orm";
import { incrementMetric } from "./metrics";

export const STALE_CLAIM_SECONDS = 90;
export const STALE_PRINTING_SECONDS = 10 * 60;
export const MAX_RETRIES = 5;

export async function sweepPrintJobs(scope: { agentId?: string; branchId?: string } = {}): Promise<{ expired: number; requeuedClaims: number; requeuedPrinting: number; stalePrinting: number; exhaustedClaims: number }> {
  const agentFilter = scope.agentId ? sql`AND agent_id = ${scope.agentId}` : sql``;
  const branchFilter = scope.branchId ? sql`AND branch_id = ${scope.branchId}` : sql``;

  // Expiry while PRINTING is not equivalent to an ordinary expiry: the agent
  // may already have handed bytes to the printer. Preserve that uncertainty.
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
        error = CASE
          WHEN expires_at <= now()
            THEN 'JOB_EXPIRED_DURING_PRINT: physical output is unknown (full, partial or none)'
          ELSE 'AGENT_EXECUTION_TIMEOUT: agent execution lease expired (agent likely crashed during physical printing; physical output is unknown)'
        END,
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
  const unknownExpiryCount = expired.rows.filter((row) => String((row as { error?: unknown }).error ?? "").startsWith("JOB_EXPIRED_DURING_PRINT")).length;
  if (result.expired > 0) incrementMetric("print_jobs_expired_total", result.expired);
  if (unknownExpiryCount > 0) incrementMetric("print_jobs_unknown_total", unknownExpiryCount);
  if (result.requeuedClaims > 0) incrementMetric("print_jobs_requeued_total", result.requeuedClaims);
  if (result.requeuedPrinting > 0) incrementMetric("print_jobs_restart_requeued_total", result.requeuedPrinting);
  if (result.requeuedPrinting > 0) incrementMetric("print_jobs_unknown_total", result.requeuedPrinting);
  if (result.stalePrinting > 0) incrementMetric("print_jobs_failed_total", result.stalePrinting);
  if (result.stalePrinting > 0) incrementMetric("print_jobs_unknown_total", result.stalePrinting);
  if (result.exhaustedClaims > 0) incrementMetric("print_jobs_failed_total", result.exhaustedClaims);
  return result;
}
