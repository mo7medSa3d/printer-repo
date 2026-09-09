import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { printJobs } from "../db/schema";
import type { JobStatus } from "./job-status";

/**
 * Execution-fencing predicates (Phase 9 / P0).
 *
 * EVERY agent-attributable write to print_jobs that can change a job's
 * lifecycle must be predicated on the CURRENT claim token INSIDE THE
 * UPDATE'S WHERE CLAUSE - not on a token compared in application memory
 * after a prior SELECT. A read-then-write without the token in the
 * predicate is a TOCTOU race: a stale worker's UPDATE can land after a
 * reclaim and clobber the authoritative attempt.
 *
 * `claim_token IS NOT DISTINCT FROM <token>` keeps legacy rows (claimed
 * before migration 0024, token NULL) working until their next, now
 * tokenized, claim - and fails closed the moment a row carries a token.
 */
export function fencedJobWrite(
  jobId: string,
  agentId: string,
  expectedStatus: JobStatus,
  claimToken: string | null,
): SQL {
  return and(
    eq(printJobs.id, jobId),
    eq(printJobs.agentId, agentId),
    eq(printJobs.status, expectedStatus),
    sql`claim_token IS NOT DISTINCT FROM ${claimToken}`,
  )!;
}

/**
 * Fencing for delivery-evidence writes (markDelivered / job_ack). These do
 * not change status but are still attributed to one specific claim: a
 * delivery or ack from a superseded attempt must not touch the current
 * attempt's row. A missing token matches only legacy tokenless claims.
 */
export function fencedDeliveryWrite(
  jobId: string,
  agentId: string,
  claimToken: string | null | undefined,
  statuses: readonly JobStatus[],
): SQL {
  const tokenPred = claimToken
    ? sql`claim_token = ${claimToken}`
    : sql`claim_token IS NULL`;
  return and(
    eq(printJobs.id, jobId),
    eq(printJobs.agentId, agentId),
    inArray(printJobs.status, [...statuses] as [JobStatus, ...JobStatus[]]),
    tokenPred,
  )!;
}
