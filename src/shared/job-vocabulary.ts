// ============================================================
// Single source of truth for operator-facing status vocabulary.
// Web console, desktop app and the Odoo screens must render the
// SAME word for the SAME state. Backend states are the gateway
// job statuses plus the derived physical outcome; the markers
// below MUST stay in lockstep with PHYSICAL_OUTCOME_UNKNOWN_MARKERS
// in src/lib/job-status.ts (a unit test locks both lists).
// ============================================================

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

export const UNKNOWN_OUTCOME_MARKERS = [
  "AGENT_EXECUTION_TIMEOUT",
  "AGENT_RESTART_DURING_PRINT",
  "JOB_EXPIRED_DURING_PRINT",
  "UNKNOWN_PARTIAL_DELIVERY",
  "UNKNOWN_SUBMISSION_OUTCOME",
] as const;

export type PhysicalOutcome = "printed" | "not_printed" | "unknown" | "unproven";

/** Client-side mirror of derivePhysicalOutcome. */
export function deriveOutcome(status: string, error?: string | null): PhysicalOutcome {
  if (status === "success") return "printed";
  const msg = error ?? "";
  if (UNKNOWN_OUTCOME_MARKERS.some((marker) => msg.startsWith(marker))) return "unknown";
  if (status === "claimed" || status === "printing") return "unproven";
  return "not_printed";
}

export function jobTone(status: string, outcome?: PhysicalOutcome): Tone {
  switch (status.toLowerCase()) {
    case "success":
      return "ok";
    case "failed":
      return outcome === "unknown" ? "warn" : "bad";
    case "expired":
      return "warn";
    case "printing":
      return "info";
    case "claimed":
      return "info";
    case "queued":
      return "neutral";
    default:
      return "neutral";
  }
}

/** Operator words for gateway job states. Never "Success" after only
 *  queueing, and never a plain "Failed" when paper may exist. */
export function jobLabel(status: string, outcome?: PhysicalOutcome): string {
  switch (status.toLowerCase()) {
    case "queued":
      return "Queued at Gateway";
    case "claimed":
      return "Sent to agent";
    case "printing":
      return "Printing";
    case "success":
      return "Printed";
    case "failed":
      if (outcome === "unknown") return "Unknown outcome";
      return "Failed (not printed)";
    case "expired":
      if (outcome === "unknown") return "Unknown outcome";
      return "Expired (never claimed)";
    default:
      return status;
  }
}

/** One-sentence operator guidance for the current job state. */
export function jobGuidance(status: string, outcome: PhysicalOutcome): string {
  if (status === "success") return "The agent confirmed the payload was fully transmitted to the printer.";
  if (outcome === "unknown") {
    return "Print status is unknown. The printer may have received part or all of the job. Automatic retry is paused to prevent duplicate printing. Verify the printer before reprinting.";
  }
  if (status === "expired") {
    return "The job waited longer than its release window without being claimed. Nothing reached the agent. Start the agent, then re-send from the source document.";
  }
  if (status === "failed") {
    return "The print failed before the printer started. Fix the cause shown in the error, then retry.";
  }
  if (status === "queued") return "Waiting for the agent to pick the job up.";
  if (status === "claimed") return "The agent received the job and is about to print it.";
  if (status === "printing") return "The printer is receiving the document now.";
  return "";
}

export function printerTone(status: string): Tone {
  switch (status) {
    case "online":
      return "ok";
    case "busy":
      return "warn";
    case "error":
    case "offline":
      return "bad";
    default:
      return "neutral";
  }
}

export function printerLabel(status: string): string {
  switch (status) {
    case "online":
      return "Online";
    case "offline":
      return "Offline";
    case "busy":
      return "Busy";
    case "error":
      return "Error - check printer";
    default:
      return "Status unknown";
  }
}

/** Agent RUNTIME states. "Online/Offline" belongs to gateway connectivity;
 *  the local agent service is Running/Stopped. Never mix the two words for
 *  one concept. */
export function agentServiceLabel(running: boolean): string {
  return running ? "Running" : "Stopped";
}

export function agentGatewayLabel(connected: boolean): string {
  return connected ? "Connected to Gateway" : "Disconnected from Gateway";
}

/** Heartbeat-derived truth: an agent that stopped reporting is NOT online,
 *  regardless of the last status row. Mirrors src/lib/agent-availability.ts. */
export const AGENT_HEARTBEAT_STALE_SECONDS = 90;

export function agentLiveView(agent: { status?: string | null; lastSeenAt?: Date | string | null; lifecycle?: string | null }, nowMs = Date.now()): { tone: Tone; label: string } {
  if (agent.lifecycle && agent.lifecycle !== "active") {
    return { tone: "neutral", label: agent.lifecycle === "retired" ? "Retired" : "Disabled" };
  }
  const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : 0;
  const fresh = Number.isFinite(seen) && nowMs - seen <= AGENT_HEARTBEAT_STALE_SECONDS * 1000;
  if (agent.status === "online" && !fresh) {
    return { tone: "warn", label: "Online (heartbeat lost)" };
  }
  if (agent.status === "online") return { tone: "ok", label: "Online" };
  return { tone: "bad", label: "Offline" };
}
