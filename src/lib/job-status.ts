// CANONICAL PHYSICAL-STATUS VOCABULARY (single source of truth; the Odoo
// outbox documents the same contract on print_gateway.print_job, and the Go
// agent mirrors the markers in agent/internal/printer/outcome.go):
//
// - Gateway DB status enum is CLOSED: queued, claimed, printing, success,
//   failed, expired. Nothing else is ever persisted (PostgreSQL CHECK) and
//   nothing else is accepted on the agent API (isJobStatus).
// - Physical outcome metadata is CLOSED: printed, not_printed, unknown.
//   success => printed; any UNKNOWN marker prefix => unknown; else
//   not_printed (derivePhysicalOutcome). There is no "maybe printed" or
//   "partially printed" outcome: ambiguity is always exactly `unknown`.
// - Odoo maps a Gateway `failed` whose error starts with any
//   _GATEWAY_UNKNOWN_MARKERS prefix to outbox status 'unknown' (never
//   'failed', which would read as "definitely not printed").
//
// The print-job lifecycle. The server and the Go agent must agree on this
// exact state machine (see agent/internal/agent/agent.go and
// agent/internal/printer/outcome.go, which mirror the markers below).
//
//   queued -> claimed -> printing -> success
//   claimed -> queued   ONLY via the agent's fenced, explicit rejection
//                     reason (AGENT_REQUEUE_REASONS: the agent received the
//                     job but provably did not touch the printer; the claim
//                     token authenticates the claim)
//   (any non-terminal state) -> expired   [once expiresAt has passed]
//
// success / failed / expired are terminal: no further transitions are
// accepted once a job reaches one of them. The late physical-outcome
// override (failed -> success) is NOT part of the general table; it exists
// only as an explicitly authorized code path via canTransition's
// allowLateSuccess option, gated by isLateSuccessAllowed (marker + TTL).
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
 * boundary (crash, execution timeout, expiry while printing, or delivery
 * without an execution report). Unknown/partial outcomes are terminal: they
 * are never auto-retried and never auto-failover; only a deliberate operator
 * reprint may re-issue them.
 */
export const PHYSICAL_OUTCOME_UNKNOWN_MARKERS = [
  "AGENT_EXECUTION_TIMEOUT",
  "AGENT_RESTART_DURING_PRINT",
  "JOB_EXPIRED_DURING_PRINT",
  "UNKNOWN_PARTIAL_DELIVERY",
  "UNKNOWN_SUBMISSION_OUTCOME",
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
  return status === "success" || status === "failed" || status === "expired";
}

// Agents may report expiration of a delivered job that has crossed its
// business TTL before local processing; the API additionally verifies that
// expiresAt has actually passed before accepting the terminal transition.
// Claiming itself remains server-side only.
const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(["expired"]),
  // claimed -> queued is the agent's explicit fenced rejection path (see the
  // header). It is never a general re-queueing capability.
  claimed: new Set(["printing", "failed", "queued", "expired"]),
  printing: new Set(["success", "failed", "expired"]),
  // Terminal states have NO outgoing transitions in the general table.
  // The failed -> success late physical-outcome override is an explicitly
  // authorized exception passed in via options, never a default.
  success: new Set([]),
  failed: new Set([]),
  expired: new Set([]),
};

export interface TransitionOptions {
  /**
   * Authorizes the one terminal override: failed -> success, when the
   * failure was a gateway-side wait timeout (not a real print failure) and
   * the agent reports the true physical outcome. Callers must verify
   * isLateSuccessAllowed BEFORE setting this.
   */
  allowLateSuccess?: boolean;
}

export function canTransition(from: JobStatus, to: JobStatus, options: TransitionOptions = {}): boolean {
  if (isTerminal(from)) {
    return options.allowLateSuccess === true && from === "failed" && to === "success";
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

/**
 * Reasons an agent may hand a claimed job back pre-execution (the agent has
 * PROVEN it did not touch the printer): executor saturation, shutdown, or an
 * unwritable local durable ledger (the agent's evidence base for whether a
 * job printed). Adding a reason requires an agent-side call site that can
 * only fire before any byte reaches hardware.
 */
export const AGENT_REQUEUE_REASONS = ["pending_full", "agent_shutting_down", "ledger_unavailable"] as const;
