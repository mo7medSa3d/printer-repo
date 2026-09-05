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
export const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function rejectRequest(res: ServerResponse, status: number, error: string) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error }));
}

/**
 * Enforce the application write-body ceiling without ever attaching data/end
 * listeners to IncomingMessage. Next.js owns the request stream exclusively.
 * The public deployment terminates requests in Caddy, which enforces the same
 * ceiling for chunked/streamed bodies before they reach this process.
 */
export function guardApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith("/api/")) return true;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) return true;

  const transferEncoding = req.headers["transfer-encoding"];
  const rawLength = req.headers["content-length"];

  // Caddy handles public chunked requests. A direct chunked request must not
  // bypass the application ceiling because the Node layer deliberately does
  // not consume the stream to count it.
  if (transferEncoding && String(transferEncoding).toLowerCase() !== "identity") {
    rejectRequest(res, 411, "CONTENT_LENGTH_REQUIRED");
    return false;
  }

  if (rawLength === undefined) {
    rejectRequest(res, 411, "CONTENT_LENGTH_REQUIRED");
    return false;
  }

  const length = Number(rawLength);
  if (!Number.isFinite(length) || length < 0 || length > MAX_API_BODY_BYTES) {
    rejectRequest(res, 413, "REQUEST_BODY_TOO_LARGE");
    return false;
  }

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
