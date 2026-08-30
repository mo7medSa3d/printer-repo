// The print-job lifecycle. The server and the Go agent must agree on this
// exact state machine (see agent/internal/agent/agent.go).
//
//   queued -> claimed -> printing -> success
//                                 -> failed
//   (any non-terminal state) -> expired   [only once expiresAt has passed]
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

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["success", "failed", "expired"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// Transitions the AGENT is allowed to request via PATCH. Claiming itself
// (queued -> claimed) only ever happens server-side in the atomic claim
// query, never via a client-supplied status value.
const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set([]), // agents never set this themselves
  claimed: new Set(["printing", "failed", "expired"]),
  printing: new Set(["success", "failed", "expired"]),
  success: new Set([]),
  failed: new Set([]),
  expired: new Set([]),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (isTerminal(from)) return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
