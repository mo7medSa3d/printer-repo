import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "node:stream";
import type { PoolClient } from "pg";
import { isIP } from "node:net";
import { pool } from "../db";
import { validateAgent } from "../lib/agent-auth";
import { inspectWsUpgradeRateLimit, recordWsUpgradeFailure } from "../lib/ws-rate-limit";
import { isTrustedProxyUpgrade, trustProxyEnabled } from "./trusted-proxy";
import { incrementMetric } from "../lib/metrics";
import {
  claimJobForDelivery,
  markJobDelivered,
  recordJobAck,
  releaseUndeliveredClaim,
  type ClaimedJobRow,
} from "../lib/job-delivery";

type AgentSocket = WebSocket & { agentId?: string; isAlive?: boolean };

type WritableSocket = Pick<Duplex, "end" | "destroy">;

const agentSockets = new Map<string, Set<AgentSocket>>();
// A rogue or wedged agent must not grow one entry without bound: sockets are
// cheap, but each holds buffers and timers. Agents normally hold exactly one;
// 8 leaves ample headroom for rolling reconnect overlap.
const MAX_AGENT_SOCKETS = 8;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED_BYTES = 1 * 1024 * 1024;
const PG_NOTIFY_CHANNEL = "print_gateway_agent_jobs";
const PG_SESSIONS_CHANNEL = "print_gateway_agent_sessions";
const PG_NOTIFY_RECONNECT_MIN_MS = 1_000;
const PG_NOTIFY_RECONNECT_MAX_MS = 30_000;
const WS_MESSAGE_BUCKET_CAPACITY = 20;
const WS_MESSAGE_REFILL_PER_SECOND = 5;

class TokenBucket {
  private tokens = WS_MESSAGE_BUCKET_CAPACITY;
  private lastRefillMs = Date.now();

  consume(cost = 1): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(
      WS_MESSAGE_BUCKET_CAPACITY,
      this.tokens + elapsed * WS_MESSAGE_REFILL_PER_SECOND,
    );
    this.lastRefillMs = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Persistent per-agent message rate limiters, keyed by agentId and
 * independent of individual socket lifetimes. Reconnecting must NOT reset
 * the bucket: token state is retained across reconnects and refreshed
 * strictly from elapsed time inside TokenBucket.consume().
 */
type WsBucketEntry = { bucket: TokenBucket; lastSeenMs: number };
const wsMessageBucketsByAgentId = new Map<string, WsBucketEntry>();
const WS_BUCKET_IDLE_TTL_MS = 60 * 60 * 1000; // prune limiters idle > 1 hour
const WS_BUCKET_GC_INTERVAL_MS = 10 * 60 * 1000; // GC runs every 10 minutes

function getBucketForAgent(agentId: string): TokenBucket {
  const now = Date.now();
  const existing = wsMessageBucketsByAgentId.get(agentId);
  if (existing) {
    existing.lastSeenMs = now;
    return existing.bucket;
  }
  const bucket = new TokenBucket();
  wsMessageBucketsByAgentId.set(agentId, { bucket, lastSeenMs: now });
  return bucket;
}

function pruneIdleWsBuckets(nowMs = Date.now()): number {
  let pruned = 0;
  for (const [agentId, entry] of wsMessageBucketsByAgentId) {
    if (nowMs - entry.lastSeenMs > WS_BUCKET_IDLE_TTL_MS) {
      wsMessageBucketsByAgentId.delete(agentId);
      pruned += 1;
    }
  }
  return pruned;
}

// Background GC: every 10 minutes prune agent limiters idle for > 1 hour
// so the global Map cannot grow without bound from churned agentIds.
const wsBucketGcTimer =
  typeof setInterval === "function"
    ? setInterval(() => {
        try {
          pruneIdleWsBuckets();
        } catch (error) {
          console.warn("[ws] bucket GC failed:", error);
        }
      }, WS_BUCKET_GC_INTERVAL_MS)
    : null;
if (wsBucketGcTimer && typeof (wsBucketGcTimer as { unref?: () => void }).unref === "function") {
  (wsBucketGcTimer as { unref: () => void }).unref();
}

export function __pruneIdleWsBucketsForTests(nowMs?: number): number {
  return pruneIdleWsBuckets(nowMs);
}

export function __clearWsBucketsForTests(): void {
  wsMessageBucketsByAgentId.clear();
}

export function closeAgentSockets(agentId: string): void {
  const set = agentSockets.get(agentId);
  if (!set || set.size === 0) return;
  for (const ws of set) {
    try { ws.close(4001, "agent deactivated"); } catch { try { ws.terminate(); } catch {} }
  }
}

export async function publishAgentSessionClose(agentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_notify($1, $2)", [PG_SESSIONS_CHANNEL, JSON.stringify({ agentId })]);
  } finally {
    try { client.release(); } catch {}
  }
}

function websocketClientKey(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    const candidates = typeof forwarded === "string" ? forwarded.split(",") : [];
    for (const candidate of candidates) {
      const ip = candidate.trim();
      if (ip && isIP(ip) !== 0) return ip.slice(0, 128);
    }
    const real = typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : "";
    if (real && isIP(real) !== 0) return real.slice(0, 128);
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "").slice(0, 128) || "unknown";
}

function writeWsHttpError(socket: WritableSocket, status: number, body: string, retryAfterSec?: number) {
  const retry = retryAfterSec !== undefined ? `Retry-After: ${retryAfterSec}\r\n` : "";
  const statusText = status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "Bad Request";
  const payload = JSON.stringify({ error: body });
  const response =
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    retry +
    `Connection: close\r\n\r\n` +
    payload;

  try {
    socket.end(response);
  } catch {
    try { socket.destroy(); } catch {}
  }
}

function logUpgradeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ws] upgrade handling failed: ${message.slice(0, 500)}`);
}

function trackAgentSocket(agentId: string, ws: AgentSocket) {
  ws.agentId = agentId;
  let set = agentSockets.get(agentId);
  if (!set) {
    set = new Set();
    agentSockets.set(agentId, set);
  }
  // Cap enforced BEFORE adding: when the set is already full, the oldest
  // socket is evicted first so the set never transiently holds
  // MAX_AGENT_SOCKETS + 1 entries under rapid-reconnect churn. The newest
  // connection is the live one (reconnect overlap), so the eviction victim
  // is always the oldest socket — never the incoming one.
  while (set.size >= MAX_AGENT_SOCKETS) {
    const oldest = set.values().next().value as AgentSocket | undefined;
    if (!oldest) break;
    try { oldest.terminate(); } catch {}
    set.delete(oldest);
  }
  set.add(ws);
  void incrementMetric("websocket_connections_opened_total");
  ws.on("close", () => {
    set!.delete(ws);
    void incrementMetric("websocket_connections_closed_total");
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
    agentId: string;
    printerId: string;
    documentType: string | null;
    status: string;
    payload: unknown;
    expiresAt: string;
    retries: number;
    claimToken: string | null;
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
      agentId: job.agentId,
      printerId: job.printerId,
      documentType: job.documentType ?? null,
      status: job.status,
      payload: job.payload,
      expiresAt,
      retries: job.retries,
      claimToken: job.claimToken ?? null,
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
    const outcome = await releaseUndeliveredClaim(job.id, job.agentId, claimed.claimToken, "websocket delivery failed after claim; job requeued for redelivery");
    return outcome === "failed" ? "failed" : "requeued";
  }
  // "Delivered" is a DATABASE fact, not a socket fact: only when the
  // delivered_at evidence write lands for THIS claim token does the gateway
  // consider the job handed over. A socket success whose evidence write
  // misses (row expired, terminal, or reclaimed mid-send) falls back to the
  // undelivered-release path instead of stranding a phantom delivery.
  const evidenced = await markJobDelivered(job.id, job.agentId, claimed.claimToken);
  if (!evidenced) {
    const outcome = await releaseUndeliveredClaim(job.id, job.agentId, claimed.claimToken, "websocket delivery evidence did not persist; job requeued for redelivery");
    // "noop" here means the row left the claimable states entirely between
    // claim and evidence (expired/terminal/cascade-deleted): there is
    // nothing left to deliver or requeue.
    if (outcome === "noop") return "not_claimable";
    return outcome === "failed" ? "failed" : "requeued";
  }
  return "delivered";
}

export async function handleAgentMessage(agentId: string, raw: string): Promise<void> {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  const { type, jobId, claimToken } = msg as { type?: unknown; jobId?: unknown; claimToken?: unknown };
  if (type !== "job_ack") return;
  if (typeof jobId !== "string" || !jobId) return;
  const token = typeof claimToken === "string" && claimToken ? claimToken : null;
  const known = await recordJobAck(jobId, agentId, token);
  if (!known) console.warn(`[ws] agent ${agentId} acked a job with no matching live claim (unknown, terminal, or superseded): ${jobId}`);
}

async function startJobNotificationListener(): Promise<() => Promise<void>> {
  let stopped = false;
  let activeClient: PoolClient | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const handleNotification = (notification: { channel?: string; payload?: string }) => {
    if (!notification.payload) return;
    if (notification.channel === PG_SESSIONS_CHANNEL) {
      try {
        const message = JSON.parse(notification.payload) as { agentId?: unknown };
        if (typeof message.agentId === "string" && message.agentId) closeAgentSockets(message.agentId);
      } catch {
        console.warn("[ws] ignored malformed agent-session notification");
      }
      return;
    }
    if (notification.channel !== PG_NOTIFY_CHANNEL) return;
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
    const capped = Math.min(PG_NOTIFY_RECONNECT_MIN_MS * (2 ** reconnectAttempt), PG_NOTIFY_RECONNECT_MAX_MS);
    // Full jitter: without it every gateway instance retries a Postgres
    // bounce in lockstep, re-hammering the database on each backoff rung.
    const delay = Math.floor(capped / 2 + Math.random() * (capped / 2));
    reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    void incrementMetric("postgres_notification_reconnects_total");
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
      client.on("notification", handleNotification);
      client.on("error", (error) => {
        void incrementMetric("postgres_notification_errors_total");
        console.warn("[ws] PostgreSQL notification listener error:", error);
        disconnect(client);
      });
      client.on("end", () => disconnect(client));
      try {
        await client.query(`LISTEN ${PG_NOTIFY_CHANNEL}`);
        await client.query(`LISTEN ${PG_SESSIONS_CHANNEL}`);
      } catch (listenError) {
        // Setup failed BEFORE adoption: the client must be released here
        // (disconnect() deliberately only touches the adopted client, and
        // the mid-setup 'error' handler above no-ops for the same reason).
        // Without this release the pool slot leaks; without the rethrow
        // below no reconnect is scheduled and push delivery dies silently.
        try { client.release(true); } catch {}
        throw listenError;
      }
      if (stopped) {
        // Startup raced shutdown between LISTEN and adoption: release
        // cleanly instead of leaking a live listener nobody owns.
        try { await client.query(`UNLISTEN ${PG_NOTIFY_CHANNEL}`); } catch {}
        try { await client.query(`UNLISTEN ${PG_SESSIONS_CHANNEL}`); } catch {}
        client.release();
        return;
      }
      activeClient = client;
      reconnectAttempt = 0;
    } catch (error) {
      void incrementMetric("postgres_notification_failures_total");
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
    try { await client.query(`UNLISTEN ${PG_SESSIONS_CHANNEL}`); } catch {}
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
    try {
      const url = req.url ?? "";
      if (!url.startsWith("/api/agent/ws")) {
        writeWsHttpError(socket, 404, "Not Found");
        return;
      }

      if (trustProxyEnabled() && !isTrustedProxyUpgrade(req.headers)) {
        writeWsHttpError(socket, 400, "TRUSTED_PROXY_REQUIRED");
        return;
      }

      const clientKey = websocketClientKey(req);
      try {
        const decision = await inspectWsUpgradeRateLimit(clientKey);
        if (!decision.allowed) {
          writeWsHttpError(socket, 429, "Too many failed WebSocket authentication attempts", decision.retryAfterSec);
          return;
        }
      } catch (error) {
        logUpgradeError(error);
        writeWsHttpError(socket, 503, "WebSocket authentication temporarily unavailable", 5);
        return;
      }

      const auth = req.headers["authorization"] ?? req.headers["Authorization"];
      const header = Array.isArray(auth) ? auth[0] : (auth as string | undefined) ?? null;
      let agent: Awaited<ReturnType<typeof validateAgent>> = null;
      try {
        agent = await validateAgent(header ?? null);
      } catch (error) {
        logUpgradeError(error);
        agent = null;
      }
      if (!agent) {
        try { await recordWsUpgradeFailure(clientKey); } catch (error) { logUpgradeError(error); }
        writeWsHttpError(socket, 401, "Unauthorized");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const aws = ws as AgentSocket;
        aws.isAlive = true;
        aws.on("pong", () => { aws.isAlive = true; });
        trackAgentSocket(agent!.id, aws);
        // No per-connection bucket init here: getBucketForAgent(agentId)
        // lazily creates or reuses the persistent agent-level limiter, so
        // reconnects retain token state instead of resetting evasion budget.
        wss.emit("connection", ws, req);
      });
    } catch (error) {
      logUpgradeError(error);
      if (!socket.destroyed && !socket.writableEnded) {
        writeWsHttpError(socket, 500, "WebSocket upgrade failed");
      } else {
        try { socket.destroy(); } catch {}
      }
    }
  });

  wss.on("connection", (ws: AgentSocket) => {
    ws.on("message", (data) => {
      ws.isAlive = true;
      const agentId = ws.agentId;
      if (!agentId) return;
      const raw = typeof data === "string" ? data : data.toString();
      const bucket = getBucketForAgent(agentId);
      if (!bucket.consume()) {
        void incrementMetric("websocket_messages_rate_limited_total");
        try { ws.close(4429, "message rate limit exceeded"); } catch {}
        return;
      }
      handleAgentMessage(agentId, raw).catch((e) => console.warn(`[ws] failed to handle message from agent ${agentId}:`, e));
    });
    ws.on("error", () => { try { ws.close(); } catch {} });
  });

  return wss;
}
