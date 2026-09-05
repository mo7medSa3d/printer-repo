import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { validateAgent } from "../lib/agent-auth";
import {
  claimJobForDelivery,
  markJobDelivered,
  recordJobAck,
  releaseUndeliveredClaim,
  type ClaimedJobRow,
} from "../lib/job-delivery";

type AgentSocket = WebSocket & { agentId?: string; isAlive?: boolean };

const agentSockets = new Map<string, Set<AgentSocket>>();
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED_BYTES = 1 * 1024 * 1024;
const PG_NOTIFY_CHANNEL = "print_gateway_agent_jobs";
const PG_NOTIFY_RECONNECT_MIN_MS = 1_000;
const PG_NOTIFY_RECONNECT_MAX_MS = 30_000;

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

export function hasOpenAgentSocket(agentId: string): boolean {
  const set = agentSockets.get(agentId);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) return true;
  return false;
}

export function sendToAgent(agentId: string, message: unknown): boolean {
  const set = agentSockets.get(agentId);
  if (!set || set.size === 0) return false;
  const open = [...set]
    .filter((ws) => ws.readyState === WebSocket.OPEN)
    .reverse();
  if (open.length === 0) return false;

  const payload = JSON.stringify(message);
  for (const target of open) {
    if (target.bufferedAmount > MAX_WS_BUFFERED_BYTES) continue;
    try {
      target.send(payload);
      return true;
    } catch (e) {
      console.warn(`[ws] send to agent ${agentId} failed; removing socket:`, e);
      set.delete(target);
      try { target.terminate(); } catch {}
    }
  }
  if (set.size === 0) agentSockets.delete(agentId);
  return false;
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

export type PushOutcome = "delivered" | "no_socket" | "not_claimable" | "requeued" | "failed";

export async function claimAndPushJobToAgent(job: { id: string; agentId: string }): Promise<PushOutcome> {
  if (!hasOpenAgentSocket(job.agentId)) return "no_socket";
  const claimed = await claimJobForDelivery(job.id, job.agentId);
  if (!claimed) return "not_claimable";
  const delivered = sendToAgent(job.agentId, buildJobEnvelope(claimed));
  if (!delivered) {
    const outcome = await releaseUndeliveredClaim(job.id, job.agentId, "websocket delivery failed after claim; job requeued for redelivery");
    return outcome === "failed" ? "failed" : "requeued";
  }
  await markJobDelivered(job.id, job.agentId);
  return "delivered";
}

export async function handleAgentMessage(agentId: string, raw: string): Promise<void> {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  const { type, jobId } = msg as { type?: unknown; jobId?: unknown };
  if (type !== "job_ack") return;
  if (typeof jobId !== "string" || !jobId) return;
  const known = await recordJobAck(jobId, agentId);
  if (!known) console.warn(`[ws] agent ${agentId} acked unknown job ${jobId}`);
}

async function startJobNotificationListener(): Promise<() => Promise<void>> {
  let stopped = false;
  let activeClient: PoolClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const handleNotification = (notification: { channel?: string; payload?: string }) => {
    if (notification.channel !== PG_NOTIFY_CHANNEL || !notification.payload) return;
    try {
      const message = JSON.parse(notification.payload) as { jobId?: unknown; agentId?: unknown };
      if (typeof message.jobId !== "string" || typeof message.agentId !== "string") return;
      if (!hasOpenAgentSocket(message.agentId)) return;
      void claimAndPushJobToAgent({ id: message.jobId, agentId: message.agentId }).catch((error) => {
        console.warn(`[ws] cross-instance job delivery failed for ${message.jobId}:`, error);
      });
    } catch {
      console.warn("[ws] ignored malformed PostgreSQL job notification");
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(PG_NOTIFY_RECONNECT_MIN_MS * (2 ** reconnectAttempt), PG_NOTIFY_RECONNECT_MAX_MS);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    console.warn(`[ws] PostgreSQL notification listener reconnecting in ${delay}ms`);
  };

  const disconnect = (client: PoolClient) => {
    if (activeClient !== client) return;
    activeClient = null;
    try { client.release(true); } catch {}
    if (!stopped) scheduleReconnect();
  };

  const connect = async (): Promise<void> => {
    if (stopped || activeClient) return;
    try {
      const client = await pool.connect();
      if (stopped) {
        client.release();
        return;
      }
      activeClient = client;
      await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
      reconnectAttempt = 0;
      client.on("notification", handleNotification);
      client.on("error", (error) => {
        console.warn("[ws] PostgreSQL notification listener error:", error);
        disconnect(client);
      });
      client.on("end", () => disconnect(client));
    } catch (error) {
      console.warn("[ws] PostgreSQL notification listener unavailable; polling remains the recovery path:", error);
      scheduleReconnect();
    }
  };

  await connect();

  return async () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const client = activeClient;
    activeClient = null;
    if (!client) return;
    try { await client.query(`UNLISTEN ${PG_NOTIFY_CHANNEL}`); } catch {}
    try { client.release(); } catch {}
  };
}

export type AgentWSSOptions = {
  enableJobNotifications?: boolean;
};

export function attachAgentWSS(server: HttpServer, options: AgentWSSOptions = {}) {
  const { enableJobNotifications = true } = options;
  const wss = new WebSocketServer({ noServer: true, path: "/api/agent/ws", maxPayload: MAX_WS_MESSAGE_BYTES });

  const interval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const a = ws as AgentSocket;
      if (a.isAlive === false) { a.terminate(); return; }
      a.isAlive = false;
      try { a.ping(); } catch {}
    });
  }, 30_000);
  wss.on("close", () => clearInterval(interval));

  let stopNotificationListener: (() => Promise<void>) | null = null;
  if (enableJobNotifications) {
    void startJobNotificationListener().then((stop) => { stopNotificationListener = stop; }).catch((error) => {
      console.warn("[ws] failed to initialize PostgreSQL notification listener:", error);
    });
    wss.on("close", () => { void stopNotificationListener?.(); });
  }

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/agent/ws")) return;
    const auth = req.headers["authorization"] ?? req.headers["Authorization"];
    const header = Array.isArray(auth) ? auth[0] : (auth as string | undefined) ?? null;
    let agent: Awaited<ReturnType<typeof validateAgent>> = null;
    try { agent = await validateAgent(header ?? null); } catch { agent = null; }
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
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: AgentSocket) => {
    ws.on("message", (data) => {
      ws.isAlive = true;
      const agentId = ws.agentId;
      if (!agentId) return;
      const raw = typeof data === "string" ? data : data.toString();
      handleAgentMessage(agentId, raw).catch((e) => console.warn(`[ws] failed to handle message from agent ${agentId}:`, e));
    });
    ws.on("error", () => { try { ws.close(); } catch {} });
  });

  return wss;
}
