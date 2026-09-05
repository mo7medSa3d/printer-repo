import { createServer } from "http";
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

function rejectOversizedRequest(res: import("http").ServerResponse) {
  res.statusCode = 413;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("connection", "close");
  res.end(JSON.stringify({ success: false, error: "REQUEST_BODY_TOO_LARGE" }));
}

function guardApiRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse): boolean {
  if (!req.url?.startsWith("/api/")) return true;
  if (!["POST", "PUT", "PATCH"].includes(req.method ?? "")) return true;

  const rawLength = req.headers["content-length"];
  if (rawLength !== undefined) {
    const length = Number(rawLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_API_BODY_BYTES) {
      rejectOversizedRequest(res);
      return false;
    }
    return true;
  }

  let seen = 0;
  req.on("data", (chunk: Buffer | string) => {
    if (res.writableEnded) return;
    seen += Buffer.byteLength(chunk);
    if (seen > MAX_API_BODY_BYTES) {
      rejectOversizedRequest(res);
      req.destroy();
    }
  });

  req.on("aborted", () => {
    if (!res.writableEnded) res.end();
  });

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
