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
