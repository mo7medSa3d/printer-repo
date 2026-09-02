import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import { validateAgent } from "@/lib/agent-auth";
import {
  claimJobForDelivery,
  markJobDelivered,
  recordJobAck,
  releaseUndeliveredClaim,
  type ClaimedJobRow,
} from "@/lib/job-delivery";

type AgentSocket = WebSocket & { agentId?: string; isAlive?: boolean };

// Per-agent connection tracking. Agent ↔ Gateway is the ONLY persistent WS.
const agentSockets = new Map<string, Set<AgentSocket>>();

// Agent → Gateway control frames are tiny; anything larger is refused by ws.
const MAX_WS_MESSAGE_BYTES = 64 * 1024;

function trackAgentSocket(agentId: string, ws: AgentSocket) {
  ws.agentId = agentId;
  let set = agentSockets.get(agentId);
  if (!set) {
    set = new Set();
    agentSockets.set(agentId, set);
  }
  set.add(ws);
  ws.on("close", () => {
    set!.delete(ws);
    if (set!.size === 0) agentSockets.delete(agentId);
  });
}

export function getAgentWsCount(agentId: string): number {
  return agentSockets.get(agentId)?.size ?? 0;
}

/** True when at least one socket for this agent is in OPEN state. */
export function hasOpenAgentSocket(agentId: string): boolean {
  const set = agentSockets.get(agentId);
  if (!set) return false;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * Write one message to exactly ONE open socket of the agent.
 *
 * Sending to every socket of the same agent would be a duplicate delivery of
 * the same job, so the newest open socket wins. Returns false when nothing
 * could actually be written — the caller must then treat the delivery as
 * failed (previously this returned true whenever a socket object existed,
 * even if it was already CLOSING, which silently lost jobs).
 */
export function sendToAgent(agentId: string, message: unknown): boolean {
  const set = agentSockets.get(agentId);
  if (!set || set.size === 0) return false;
  const open = [...set].filter((ws) => ws.readyState === WebSocket.OPEN);
  if (open.length === 0) return false;
  const target = open[open.length - 1];
  const data = JSON.stringify(message);
  try {
    target.send(data);
  } catch (e) {
    console.warn(`[ws] send to agent ${agentId} failed:`, e);
    return false;
  }
  return true;
}

export type JobDeliveryEnvelope = {
  type: "print_job";
  job: {
    id: string;
    branchId: string;
    agentId: string;
    printerId: string;
    destinationId: string | null;
    documentType: string | null;
    status: string;
    payload: unknown;
    expiresAt: string;
    retries: number;
  };
  // Flat aliases so an older agent build that reads `id`/`printerId`/`payload`
  // straight off the message keeps working against a new gateway.
  id: string;
  printerId: string;
  payload: unknown;
  expiresAt: string;
};

export function buildJobEnvelope(job: ClaimedJobRow): JobDeliveryEnvelope {
  const expiresAt = job.expiresAt instanceof Date ? job.expiresAt.toISOString() : new Date(job.expiresAt).toISOString();
  return {
    type: "print_job",
    job: {
      id: job.id,
      branchId: job.branchId,
      agentId: job.agentId,
      printerId: job.printerId,
      destinationId: job.destinationId ?? null,
      documentType: job.documentType ?? null,
      status: job.status,
      payload: job.payload,
      expiresAt,
      retries: job.retries,
    },
    id: job.id,
    printerId: job.printerId,
    payload: job.payload,
    expiresAt,
  };
}

export type PushOutcome =
  | "delivered" // claimed, written to a socket, agent owns it now
  | "no_socket" // agent is not connected; row stays queued for the poll path
  | "not_claimable" // already claimed/terminal/expired — nothing was sent
  | "requeued" // claim taken but send failed; row is queued again
  | "failed"; // claim taken, send failed, delivery budget exhausted

/**
 * Claim a job and only then push it to the agent.
 *
 * Ordering is the whole point: the queued→claimed transition commits BEFORE
 * a single byte reaches the agent, so the agent can never execute (and report
 * progress on) a job the gateway still believes is queued. If the socket
 * write fails after the claim, the claim is released so the job stays
 * recoverable under the same job id.
 */
export async function claimAndPushJobToAgent(job: { id: string; agentId: string }): Promise<PushOutcome> {
  if (!hasOpenAgentSocket(job.agentId)) return "no_socket";

  const claimed = await claimJobForDelivery(job.id, job.agentId);
  if (!claimed) return "not_claimable";

  const delivered = sendToAgent(job.agentId, buildJobEnvelope(claimed));
  if (!delivered) {
    const outcome = await releaseUndeliveredClaim(
      job.id,
      job.agentId,
      "websocket delivery failed after claim; job requeued for redelivery"
    );
    return outcome === "failed" ? "failed" : "requeued";
  }

  await markJobDelivered(job.id, job.agentId);
  return "delivered";
}

/** Handles one Agent → Gateway control frame. Exported for tests. */
export async function handleAgentMessage(agentId: string, raw: string): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // non-JSON keepalive noise
  }
  if (!msg || typeof msg !== "object") return;
  const { type, jobId } = msg as { type?: unknown; jobId?: unknown };
  if (type !== "job_ack") return;
  if (typeof jobId !== "string" || !jobId) return;
  // Acknowledgement is receipt only: it never changes the job status.
  const known = await recordJobAck(jobId, agentId);
  if (!known) {
    console.warn(`[ws] agent ${agentId} acked unknown job ${jobId}`);
  }
}

export function attachAgentWSS(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, path: "/api/agent/ws", maxPayload: MAX_WS_MESSAGE_BYTES });

  // Heartbeat for dead WS detection (per ws docs)
  const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const a = ws as AgentSocket;
      if (a.isAlive === false) {
        a.terminate();
        return;
      }
      a.isAlive = false;
      try {
        a.ping();
      } catch {}
    });
  }, 30_000);

  wss.on("close", () => clearInterval(interval));

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    // Only handle /api/agent/ws ; let Next handle others (none)
    if (!url.startsWith("/api/agent/ws")) return;

    const auth = req.headers["authorization"] ?? req.headers["Authorization"];
    const header = Array.isArray(auth) ? auth[0] : (auth as string | undefined) ?? null;

    // validateAgent expects "Bearer agt:secret" and does DB lookup
    let agent: Awaited<ReturnType<typeof validateAgent>> = null;
    try {
      agent = await validateAgent(header ?? null);
    } catch {
      agent = null;
    }
    if (!agent) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 22\r\n\r\n{\"error\":\"Unauthorized\"}");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const aws = ws as AgentSocket;
      aws.isAlive = true;
      aws.on("pong", () => { aws.isAlive = true; });
      trackAgentSocket(agent!.id, aws);
      // No jobs are sent on connect: a job is only ever pushed after the
      // gateway has claimed it (claimAndPushJobToAgent). Undelivered claims
      // are recovered by the agent's poll path.
      wss.emit("connection", ws, req);
    });
  });

  // Agent → Gateway frames: pong keepalives and `{"type":"job_ack","jobId"}`.
  wss.on("connection", (ws: AgentSocket) => {
    ws.on("message", (data) => {
      ws.isAlive = true;
      const agentId = ws.agentId;
      if (!agentId) return;
      const raw = typeof data === "string" ? data : data.toString();
      handleAgentMessage(agentId, raw).catch((e) => {
        console.warn(`[ws] failed to handle message from agent ${agentId}:`, e);
      });
    });
    ws.on("error", () => {
      try { ws.close(); } catch {}
    });
  });

  return wss;
}
