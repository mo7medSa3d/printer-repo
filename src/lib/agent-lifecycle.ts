import { db } from "../db";
import { agents, printers } from "../db/schema";
import { eq } from "drizzle-orm";
import { canTransitionLifecycle } from "./lifecycle";
import { generatePairingCode, hashPairingCode } from "./agent-auth";
import { logWarn } from "./log";
import { closeAgentSockets, publishAgentSessionClose } from "../server/ws";

export type AgentLifecycleResult = {
  changed: boolean;
  lifecycle: string;
  pairingCode: string | null;
};

/**
 * The single authoritative agent lifecycle transition used by BOTH the
 * PATCH /api/agents/[id] route and the dashboard server action. Divergent
 * copies of this flow previously drifted (a no-op PATCH destroyed
 * credentials; socket teardown depended on the target state instead of the
 * credential change), so there is now exactly one implementation.
 *
 * Rules:
 *  - current === next is a true no-op: credentials and pairing state untouched.
 *  - every real transition nulls the agent secret (revocation first).
 *  - disabled -> active mints a fresh single-use pairing code (10 min TTL).
 *  - every real transition tears down live WebSocket sessions locally and
 *    publishes a cluster-wide close.
 */
export async function transitionAgentLifecycle(agentId: string, next: "active" | "disabled" | "retired"): Promise<AgentLifecycleResult | null> {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return null;
  if (agent.lifecycle === next) {
    return { changed: false, lifecycle: next, pairingCode: null };
  }
  if (!canTransitionLifecycle(agent.lifecycle, next)) {
    throw new LifecycleConflict(`invalid lifecycle transition: ${agent.lifecycle} -> ${next}`);
  }
  const now = new Date();
  const reenable = agent.lifecycle === "disabled" && next === "active";
  const pairingCode = reenable ? generatePairingCode() : null;
  const pairingCodeHash = pairingCode ? hashPairingCode(pairingCode) : null;
  await db.transaction(async (tx) => {
    await tx.update(agents).set({
      lifecycle: next,
      secret: null,
      pairingCodeHash,
      pairingCodeExpiresAt: pairingCode ? new Date(now.getTime() + 10 * 60 * 1000) : null,
      status: "offline",
      updatedAt: now,
    }).where(eq(agents.id, agentId));
    if (next !== "active") {
      await tx.update(printers).set({ lifecycle: "disabled", updatedAt: now }).where(eq(printers.agentId, agentId));
    }
  });

  // The secret was just nullified; an established WS socket would otherwise
  // keep receiving jobs until its next reconnect. Teardown runs on EVERY
  // credential-rotating transition, regardless of the target lifecycle.
  try { closeAgentSockets(agentId); } catch { /* sockets already gone */ }
  void publishAgentSessionClose(agentId).catch((error) => {
    logWarn("agent.session_close_publish_failed", { agentId, error: error instanceof Error ? error.message : String(error) });
  });

  return { changed: true, lifecycle: next, pairingCode };
}

export class LifecycleConflict extends Error {}
