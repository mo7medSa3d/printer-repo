export const DEFAULT_AGENT_STALE_THRESHOLD_SECONDS = 90;

export function agentStaleThresholdSeconds(): number {
  const raw = Number(process.env.STALE_AGENT_THRESHOLD_SECONDS ?? DEFAULT_AGENT_STALE_THRESHOLD_SECONDS);
  if (!Number.isFinite(raw) || raw < 10 || raw > 3600) return DEFAULT_AGENT_STALE_THRESHOLD_SECONDS;
  return Math.floor(raw);
}

export type AgentAvailability = {
  available: boolean;
  reason: "active-online-fresh" | "inactive-lifecycle" | "offline" | "stale" | "missing-heartbeat";
};

export function getAgentAvailability(
  agent: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null },
  now = new Date(),
): AgentAvailability {
  if (agent.lifecycle !== "active") return { available: false, reason: "inactive-lifecycle" };
  if (agent.status !== "online") return { available: false, reason: "offline" };
  if (!agent.lastSeenAt) return { available: false, reason: "missing-heartbeat" };
  const lastSeen = new Date(agent.lastSeenAt).getTime();
  if (!Number.isFinite(lastSeen)) return { available: false, reason: "missing-heartbeat" };
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  if (ageSeconds < 0 || ageSeconds > agentStaleThresholdSeconds()) {
    return { available: false, reason: "stale" };
  }
  return { available: true, reason: "active-online-fresh" };
}

export function isAgentAvailableForJob(
  agent: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null },
  now = new Date(),
): boolean {
  return getAgentAvailability(agent, now).available;
}
