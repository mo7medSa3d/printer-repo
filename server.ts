import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";
import { sweepPrintJobs } from "./src/lib/job-maintenance";
import { cleanupAuthRateLimits } from "./src/lib/auth-rate-limit";
import { cleanupExpiredManagerSessions } from "./src/lib/manager-auth";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const JOB_SWEEP_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;
const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function rejectOversizedRequest(res: ServerResponse) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 413;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error: "REQUEST_BODY_TOO_LARGE" }));
}

function guardApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith("/api/")) return true;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) return true;

  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    const length = Number(rawLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_API_BODY_BYTES) {
      rejectOversizedRequest(res);
      return false;
    }
  }

  // Content-Length is only an early rejection. For HTTP/1.1 chunked requests
  // there is no trustworthy declared size, so count bytes on the IncomingMessage
  // stream itself. The listener observes chunks without consuming them, allowing
  // Next.js to continue parsing the same stream. Once the hard ceiling is crossed
  // we return 413 and destroy the request connection before a huge JSON payload
  // can be fully buffered by a route handler.
  let received = 0;
  let rejected = false;
  req.on("data", (chunk: Buffer | string) => {
    if (rejected) return;
    received += Buffer.byteLength(chunk);
    if (received > MAX_API_BODY_BYTES) {
      rejected = true;
      rejectOversizedRequest(res);
      req.destroy();
    }
  });
  req.on("aborted", () => { rejected = true; });

  return true;
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (!guardApiRequest(req, res)) return;
    handle(req, res);
  });

  attachAgentWSS(server);

  const sweep = () => {
    sweepPrintJobs().catch((error) => {
      console.error("[job-maintenance] sweep failed", error);
    });
  };
  sweep();
  const sweepTimer = setInterval(sweep, JOB_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const housekeeping = () => {
    Promise.all([
      cleanupAuthRateLimits(),
      cleanupExpiredManagerSessions(),
    ]).catch((error) => {
      console.error("[auth-maintenance] cleanup failed", error);
    });
  };
  housekeeping();
  const housekeepingTimer = setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS);
  housekeepingTimer.unref();

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (Agent WS at /api/agent/ws)`);
  });
});
