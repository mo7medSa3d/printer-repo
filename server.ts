import { createServer } from "http";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  // Attach Agent ↔ Gateway WS (ONLY persistent WS per spec). Desktop Manager uses HTTPS polling.
  attachAgentWSS(server);

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (Agent WS at /api/agent/ws)`);
  });
});
