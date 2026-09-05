import { createServer } from "node:http";
import { Pool } from "pg";
import { attachAgentWSS } from "../src/server/ws";

const CHANNEL = "print_gateway_agent_jobs";
const WAIT_MS = 500;
const MAX_WAIT_MS = 15_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForListener(pool: Pool, previousPid?: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE query ILIKE $1
          AND pid <> pg_backend_pid()
        ORDER BY backend_start DESC`,
      [`LISTEN ${CHANNEL}%`],
    );
    const pid = result.rows.map((row) => Number(row.pid)).find((candidate) => candidate !== previousPid);
    if (pid) return pid;
    await sleep(WAIT_MS);
  }
  throw new Error(`Timed out waiting for PostgreSQL LISTEN ${CHANNEL} connection`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const admin = new Pool({ connectionString: url, max: 2 });
  const server = createServer();
  attachAgentWSS(server);

  try {
    await admin.query("SELECT 1");
    const firstPid = await waitForListener(admin);
    console.log(`Initial LISTEN backend: ${firstPid}`);

    const terminated = await admin.query("SELECT pg_terminate_backend($1::int) AS terminated", [firstPid]);
    if (!terminated.rows[0]?.terminated) throw new Error(`pg_terminate_backend(${firstPid}) did not terminate the listener`);
    console.log(`Forced disconnect of LISTEN backend ${firstPid}`);

    const replacementPid = await waitForListener(admin, firstPid);
    console.log(`Reconnected LISTEN backend: ${replacementPid}`);
    if (replacementPid === firstPid) throw new Error("LISTEN backend PID did not change after forced disconnect");

    const check = await admin.query("SELECT 1 AS ok");
    if (check.rows[0]?.ok !== 1) throw new Error("PostgreSQL connectivity check failed after reconnect");
    console.log("PostgreSQL LISTEN failure-injection proof passed.");
  } finally {
    await admin.end();
    server.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
