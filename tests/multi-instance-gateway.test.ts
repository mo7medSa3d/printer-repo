import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  hasTestDatabase,
  applyMigrations,
  seedFixture,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { getWorkerSchema } from "../src/lib/worker-schema";

const run = describe.skipIf(!hasTestDatabase || process.env.RUN_MULTI_INSTANCE_TEST !== "1");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startGateway(port: number, databaseName: string, workerSchema: string | null): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    TRUST_PROXY: "0",
    ODOO_DATABASE_NAME: databaseName,
    GATEWAY_JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
    MANAGER_USERNAME: "test-manager",
    MANAGER_PASSWORD_HASH: "",
  };

  // A spawned production-like Gateway must not inherit Vitest's worker
  // isolation variables. Pass the exact parent worker schema explicitly so
  // both Gateway instances use the same PostgreSQL test data as this process.
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;

  if (workerSchema) env.TEST_WORKER_SCHEMA = workerSchema;
  else delete env.TEST_WORKER_SCHEMA;

  return spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway ${port} exited before becoming healthy: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // server still starting
    }
    await sleep(100);
  }
  throw new Error(`gateway ${port} did not become healthy: ${output}`);
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000)),
  ]);
}

run("multi-instance Gateway / PostgreSQL source of truth", () => {
  let fixture: Fixture;
  let gatewayA: ChildProcess;
  let gatewayB: ChildProcess;
  const portA = 3111;
  const portB = 3112;
  const databaseName = "multi_instance_test";
  const workerSchema = getWorkerSchema();

  beforeAll(async () => {
    await applyMigrations();
    fixture = await seedFixture();
    gatewayA = startGateway(portA, databaseName, workerSchema);
    gatewayB = startGateway(portB, databaseName, workerSchema);
    await Promise.all([waitForHealth(portA, gatewayA), waitForHealth(portB, gatewayB)]);
    // The WS module establishes PostgreSQL LISTEN asynchronously. This is a
    // small stabilization delay, not a substitute for sharing the DB schema.
    await sleep(500);
  });

  beforeEach(async () => {
    await pool().query("DELETE FROM print_jobs");
  });

  afterAll(async () => {
    await Promise.all([stopGateway(gatewayA), stopGateway(gatewayB)]);
    await closePool();
  });

  it("delivers a job created on Gateway A to an agent connected to Gateway B", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${portB}/api/agent/ws`, {
      headers: { Authorization: fixture.agentAuth },
    });
    const messagePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for cross-instance print_job")), 10_000);
      ws.on("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("close", () => {
        clearTimeout(timer);
      });
    });
    await once(ws, "open");
    await sleep(200);

    try {
      const response = await fetch(`http://127.0.0.1:${portA}/api/print/jobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.odooKey}`,
          "X-Odoo-Database": databaseName,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          branchId: fixture.branchId,
          destinationId: fixture.destinationId,
          documentType: "receipt",
          payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
        }),
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { id: string };

      const message = await messagePromise;
      expect(message.type).toBe("print_job");
      expect((message.job as { id: string }).id).toBe(created.id);

      const row = await pool().query("SELECT status, agent_id FROM print_jobs WHERE id = $1", [created.id]);
      expect(row.rows[0].status).toBe("claimed");
      expect(row.rows[0].agent_id).toBe(fixture.agentId);
    } finally {
      ws.close();
    }
  });

  it("keeps the same job identity when both instances attempt the claim", async () => {
    const expires = new Date(Date.now() + 60_000);
    await pool().query(
      `INSERT INTO print_jobs (id, branch_id, destination_id, document_type, agent_id, printer_id, status, payload, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'receipt', $4, $5, 'queued', '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb, $6, now(), now())`,
      ["multi-claim", fixture.branchId, fixture.destinationId, fixture.agentId, fixture.printerId, expires],
    );

    const messagesA: Record<string, unknown>[] = [];
    const messagesB: Record<string, unknown>[] = [];
    const wsA = new WebSocket(`ws://127.0.0.1:${portA}/api/agent/ws`, { headers: { Authorization: fixture.agentAuth } });
    const wsB = new WebSocket(`ws://127.0.0.1:${portB}/api/agent/ws`, { headers: { Authorization: fixture.agentAuth } });
    const collectMessage = (target: Record<string, unknown>[]) => (data: WebSocket.RawData) => {
      target.push(JSON.parse(String(data)) as Record<string, unknown>);
    };
    wsA.on("message", collectMessage(messagesA));
    wsB.on("message", collectMessage(messagesB));

    await Promise.all([once(wsA, "open"), once(wsB, "open")]);
    await sleep(200);

    try {
      // Exercise the actual PostgreSQL LISTEN/NOTIFY cross-instance path.
      await pool().query("SELECT pg_notify('print_gateway_agent_jobs', $1)", [
        JSON.stringify({ jobId: "multi-claim", agentId: fixture.agentId }),
      ]);

      const deadline = Date.now() + 5_000;
      let delivered: Record<string, unknown>[] = [];
      while (Date.now() < deadline) {
        delivered = [...messagesA, ...messagesB].filter((message) =>
          message.type === "print_job" && (message.job as { id?: unknown } | undefined)?.id === "multi-claim"
        );
        if (delivered.length === 1) break;
        await sleep(50);
      }

      expect(delivered).toHaveLength(1);
      const row = await pool().query(
        "SELECT COUNT(*)::int AS count, COUNT(DISTINCT id)::int AS ids, status, agent_id FROM print_jobs WHERE id = $1 GROUP BY status, agent_id",
        ["multi-claim"],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].count).toBe(1);
      expect(row.rows[0].ids).toBe(1);
      expect(row.rows[0].status).toBe("claimed");
      expect(row.rows[0].agent_id).toBe(fixture.agentId);
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});
