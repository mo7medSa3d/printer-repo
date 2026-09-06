import { createServer } from "http";
import next from "next";
import { attachAgentWSS } from "./src/server/ws";
import { guardApiRequest } from "./src/server/request-guard";
import { sweepPrintJobs } from "./src/lib/job-maintenance";
import { cleanupAuthRateLimits } from "./src/lib/auth-rate-limit";
import { cleanupExpiredManagerSessions } from "./src/lib/manager-auth";
import { applyApiCors, handleApiCorsPreflight } from "./src/server/cors";
import { configuredOdooDatabaseName } from "./src/lib/odoo-auth";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const JOB_SWEEP_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;

if (process.env.NODE_ENV === "production" && process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD === "1") {
  throw new Error("Refusing production startup with ALLOW_PLAINTEXT_MANAGER_PASSWORD=1; configure MANAGER_PASSWORD_HASH instead.");
}

// The Gateway currently supports one Odoo database per installation. Without
// this binding, native ids such as `odoo_company_1` are not globally unique
// across separate Odoo databases, so accidental shared-Gateway deployment
// would create an authorization boundary the schema cannot represent.
if (process.env.NODE_ENV === "production" && !configuredOdooDatabaseName()) {
  throw new Error("Refusing production startup without ODOO_DATABASE_NAME; configure the exact Odoo database served by this Gateway.");
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (handleApiCorsPreflight(req, res)) return;
    applyApiCors(req, res);

    guardApiRequest(req, res)
      .then((guarded) => {
        if (!guarded) return; // already answered (413/499/400)
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

  if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
    console.warn("[security] TRUST_PROXY enabled: client IP is taken from X-Forwarded-For. Only run behind a proxy that OVERWRITES that header with the real client address (the bundled Caddyfile does).");
  }

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (Agent WS at /api/agent/ws)`);
  });
});
