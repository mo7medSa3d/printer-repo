// The print-job lifecycle. The server and the Go agent must agree on this
// exact state machine (see agent/internal/agent/agent.go).
//
//   queued -> claimed -> printing -> success
//                                 -> failed
//   (any non-terminal state) -> expired   [once expiresAt has passed]
//
// success / failed / expired are terminal: no further transitions are
// accepted once a job reaches one of them.
export const JOB_STATUSES = [
  "queued",
  "claimed",
  "printing",
  "success",
  "failed",
  "expired",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const PHYSICAL_OUTCOMES = ["not_printed", "printed", "unknown"] as const;
export type PhysicalOutcome = (typeof PHYSICAL_OUTCOMES)[number];

/**
 * A terminal logical failure does not necessarily mean that no paper came out.
 * These markers identify cases where execution reached an ambiguous physical
 * boundary (crash, execution timeout, or expiry while printing).
 */
export const PHYSICAL_OUTCOME_UNKNOWN_MARKERS = [
  "AGENT_EXECUTION_TIMEOUT",
  "AGENT_RESTART_DURING_PRINT",
  "JOB_EXPIRED_DURING_PRINT",
] as const;

export function derivePhysicalOutcome(status: JobStatus | string, error: string | null | undefined): PhysicalOutcome {
  if (status === "success") return "printed";
  if (PHYSICAL_OUTCOME_UNKNOWN_MARKERS.some((marker) => (error ?? "").startsWith(marker))) return "unknown";
  return "not_printed";
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: JobStatus): boolean {
  return new Set<JobStatus>(["success", "failed", "expired"]).has(status);
}

// Agents may report expiration when a delivered job has crossed its business
// TTL before local processing. This is safe because the API additionally
// verifies that expiresAt has actually passed before accepting the terminal
// transition. Claiming itself remains server-side only.
const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["expired"]),
  // claimed -> queued is the agent's explicit rejection path: the agent
  // received the job but its local queue was full, so it hands it back
  // (see PATCH /api/agent/jobs, reason "pending_full"). The route gates
  // this transition on the exact reason — it is never a general
  // re-queueing capability.
  claimed: new Set(["printing", "failed", "queued", "expired"]),
  printing: new Set(["success", "failed", "expired"]),
  // failed -> success is NOT a general transition. It exists ONLY as the
  // late physical-outcome override (isLateSuccessAllowed): the gateway's
  // stale-printing sweep may have failed the job while the agent actually
  // finished printing. The agent is the only source of truth about the
  // physical outcome.
  success: new Set([]),
  failed: new Set(["success"]),
  expired: new Set([]),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (isTerminal(from)) {
    // The one terminal override: failed -> success (late physical outcome).
    return from === "failed" && to === "success";
  }
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Errors that mark a failure as "the gateway gave up waiting for the
 * physical print" — as opposed to a real print failure (connection
 * refused, capability mismatch, ...). Only these may be overridden by a
 * late agent success report.
 */
const LATE_SUCCESS_ERROR_MARKERS = ["AGENT_EXECUTION_TIMEOUT", "AGENT_RESTART_DURING_PRINT"] as const;

/** A late success override is only meaningful while the failure is recent. */
export const LATE_SUCCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LateSuccessCandidate {
  status: JobStatus;
  error: string | null;
  updatedAt: Date;
}

export function isLateSuccessAllowed(job: LateSuccessCandidate, nowMs: number): boolean {
  if (job.status !== "failed") return false;
  const error = job.error ?? "";
  if (!LATE_SUCCESS_ERROR_MARKERS.some((marker) => error.startsWith(marker))) return false;
  const age = nowMs - new Date(job.updatedAt).getTime();
  return age >= 0 && age <= LATE_SUCCESS_MAX_AGE_MS;
}
