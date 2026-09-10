import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, type Fixture } from "./helpers/pg";
import { attachAgentWSS, getAgentWsCount } from "../src/server/ws";

const suite = describe.skipIf(!hasTestDatabase);
suite("per-agent websocket cap", () => {
  let server: Server; let port: number; let f: Fixture; const sockets: WebSocket[] = [];
  beforeAll(async () => {
    await applyMigrations();
    server = createServer((_req, res) => { res.writeHead(404).end(); });
    attachAgentWSS(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });

  it("sheds the oldest socket past the per-agent cap and keeps the newest", async () => {
    const opened: WebSocket[] = [];
    for (let i = 0; i < 10; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, { headers: { Authorization: f.agentAuth } });
      sockets.push(ws);
      opened.push(ws);
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    }
    // Allow the server-side shed (terminate + close handshake) to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(getAgentWsCount(f.agentId)).toBeLessThanOrEqual(8);
    expect(opened[opened.length - 1].readyState).toBe(WebSocket.OPEN);
  });
});
