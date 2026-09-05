import { createServer } from "http";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";
import { sweepPrintJobs } from "./src/lib/job-maintenance";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const JOB_SWEEP_INTERVAL_MS = 30_000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  // Attach Agent ↔ Gateway WS (ONLY persistent WS per spec). Desktop Manager uses HTTPS polling.
  attachAgentWSS(server);

  const sweep = () => {
    sweepPrintJobs().catch((error) => {
      console.error("[job-maintenance] sweep failed", error);
    });
  };
  // Job TTL/recovery must not depend on an agent polling endpoint. Multiple
  // gateway replicas may run this loop; the SQL updates are idempotent.
  sweep();
  const sweepTimer = setInterval(sweep, JOB_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (Agent WS at /api/agent/ws)`);
  });
});
