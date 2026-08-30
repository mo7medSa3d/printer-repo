import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import { validateAgent } from "@/lib/agent-auth";
import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { and, eq } from "drizzle-orm";

type AgentSocket = WebSocket & { agentId?: string; isAlive?: boolean };

// Per-agent connection tracking. Agent ↔ Gateway is the ONLY persistent WS.
const agentSockets = new Map<string, Set<AgentSocket>>();

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

export function broadcastJobToAgent(agentId: string, job: unknown) {
  const set = agentSockets.get(agentId);
  if (!set || set.size === 0) return false;
  const payload = JSON.stringify(job);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
  return true;
}

// Called from print job creation paths (Odoo/test-print) to push immediately
export function tryPushJob(job: { id: string; agentId: string; printerId: string; payload: unknown; expiresAt: string | Date }) {
  const expiresAt = typeof job.expiresAt === "string" ? job.expiresAt : job.expiresAt.toISOString();
  return broadcastJobToAgent(job.agentId, {
    id: job.id,
    printerId: job.printerId,
    payload: job.payload,
    expiresAt,
  });
}

/**
 * Push a freshly created job over the agent WebSocket AND record the gateway
 * lease that the poll path (GET /api/agent/jobs) would normally establish.
 *
 * Why this matters: the PATCH status machine (src/lib/job-status.ts) refuses
 * every transition out of 'queued' — only a 'claimed' row may become
 * 'printing'/'failed'. A bare WS push left the job in 'queued', so a
 * WS-connected agent could never report progress/success (PATCH → 409), and
 * the job churned until TTL/reclaim. Now, when the push actually reached an
 * open socket, we atomically claim the row. If a poll (or another creator)
 * claimed it concurrently, the UPDATE simply matches 0 rows.
 *
 * Returns true when the job was delivered over WS (and the claim attempt was
 * made). A false return means "no open socket" — the row stays 'queued' and
 * the agent's poll fallback claims it normally.
 *
 * Known, accepted ms-window: a very fast agent can PATCH 'printing' between
 * the WS dispatch and the claim landing; that single progress tick may be
 * rejected with 409, but the terminal success/failed PATCH then lands
 * correctly against the claimed row.
 */
export async function pushJobToAgentWithClaim(job: { id: string; agentId: string; printerId: string; payload: unknown; expiresAt: string | Date }): Promise<boolean> {
  const delivered = tryPushJob(job);
  if (!delivered) return false;
  await db.update(printJobs)
    .set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(printJobs.id, job.id), eq(printJobs.status, "queued")));
  return true;
}

export function attachAgentWSS(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, path: "/api/agent/ws" });

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
      // Optionally send a hello with agent id for diagnostics
      // Do not send jobs here; jobs are pushed via broadcastJobToAgent after claim/creation.
      wss.emit("connection", ws, req);
    });
  });

  // Handle WS connections: agent does not send messages except pong; just keep alive.
  wss.on("connection", (ws: AgentSocket) => {
    ws.on("message", () => {
      // Ignore; agent is producer-agnostic. But keep alive.
      ws.isAlive = true;
    });
    ws.on("error", () => {
      try { ws.close(); } catch {}
    });
  });

  return wss;
}
