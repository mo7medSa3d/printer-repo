import { createServer } from "http";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";
import { guardApiRequest } from "./src/server/request-guard";
import { sweepPrintJobs } from "./src/lib/job-maintenance";
import { cleanupAuthRateLimits } from "./src/lib/auth-rate-limit";
import { cleanupExpiredManagerSessions } from "./src/lib/manager-auth";
import { applyApiCors, handleApiCorsPreflight } from "./src/server/cors";
import { configuredOdooDatabaseName } from "./src/lib/odoo-auth";
import { isTrustedProxyRequest, trustProxyEnabled } from "./src/server/trusted-proxy";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const JOB_SWEEP_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;

if (process.env.NODE_ENV === "production" && process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD === "1") {
  throw new Error("Refusing production startup with ALLOW_PLAINTEXT_MANAGER_PASSWORD=1; configure MANAGER_PASSWORD_HASH instead.");
}

if (process.env.NODE_ENV === "production" && !configuredOdooDatabaseName()) {
  throw new Error("Refusing production startup without ODOO_DATABASE_NAME; configure the exact Odoo database served by this Gateway.");
}

if (process.env.NODE_ENV === "production" && trustProxyEnabled()) {
  const proxySecret = process.env.TRUST_PROXY_SECRET?.trim();
  if (!proxySecret || proxySecret.length < 32) {
    throw new Error("Refusing production startup with TRUST_PROXY enabled without TRUST_PROXY_SECRET (>=32 chars).");
  }
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (trustProxyEnabled() && req.url !== "/api/health") {
      const protocolReq = new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: Object.entries(req.headers).flatMap(([key, value]) => value == null ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]),
      });
      if (!isTrustedProxyRequest(protocolReq)) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "TRUSTED_PROXY_REQUIRED" }));
        return;
      }
    }

    if (handleApiCorsPreflight(req, res)) return;
    applyApiCors(req, res);

    guardApiRequest(req, res)
      .then((guarded) => {
        if (!guarded) return;
        handle(guarded, res);
      })
      .catch((error) => {
        console.error("[request-guard] failed to process request", error);
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "INTERNAL_ERROR" }));
        }
        req.destroy();
      });
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

  if (trustProxyEnabled()) {
    console.warn("[security] TRUST_PROXY enabled: only requests carrying the proxy authentication token are trusted for forwarded-client-IP handling. The bundled Caddyfile injects the token and overwrites X-Forwarded-For.");
  }

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (Agent WS at /api/agent/ws)`);
  });
});
