import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import {
  hasTestDatabase,
  applyMigrations,
  seedFixture,
  closePool,
  pool,
  insertQueuedJob,
  type Fixture,
} from "./helpers/pg";
import { getWorkerSchema } from "../src/lib/worker-schema";

const run = describe.skipIf(!hasTestDatabase || process.env.RUN_MULTI_INSTANCE_TEST !== "1");

type GatewayProcess = {
  child: ChildProcess;
  output: () => string;
  ready: Promise<number>;
};

function startGateway(databaseName: string, workerSchema: string | null): GatewayProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: "0",
    HOSTNAME: "127.0.0.1",
    TRUST_PROXY: "0",
    ODOO_DATABASE_NAME: databaseName,
    GATEWAY_JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
    MANAGER_USERNAME: "test-manager",
    MANAGER_PASSWORD_HASH: "",
  };

  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;

  if (workerSchema) env.TEST_WORKER_SCHEMA = workerSchema;
  else delete env.TEST_WORKER_SCHEMA;

  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  let output = "";
  let resolveReady!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  let settledReady = false;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const appendOutput = (chunk: Buffer | string) => {
    output += String(chunk);
    if (output.length > 16_384) output = output.slice(-16_384);
    if (!settledReady) {
      const match = output.match(/> Ready on http:\/\/127\.0\.0\.1:(\d+) /);
      if (match) {
        settledReady = true;
        resolveReady(Number(match[1]));
      }
    }
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.on("error", (error) => appendOutput(`\n[child error] ${error.stack ?? error.message}\n`));
  child.on("exit", (code, signal) => {
    if (!settledReady) {
      settledReady = true;
      rejectReady(new Error(`gateway exited before listening (code=${code ?? "null"}, signal=${signal ?? "null"})\n${output}`));
    }
  });

  return { child, output: () => output, ready };
}

async function waitForHealth(gateway: GatewayProcess): Promise<number> {
  const port = await gateway.ready;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`gateway ${port} exited before becoming healthy:\n${gateway.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return port;
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway ${port} did not become healthy:\n${gateway.output()}`);
}

async function waitForWebSocketOpen(ws: WebSocket, label: string, gateways: GatewayProcess[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      const diagnostics = gateways.map((gateway, index) => `\n--- Gateway ${index + 1} output ---\n${gateway.output()}`).join("");
      reject(new Error(`${error.message}${diagnostics}`));
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    ws.once("open", finishResolve);
    ws.once("error", (error) => finishReject(new Error(`${label} WebSocket error: ${error.message}`)));
    ws.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        finishReject(new Error(`${label} WebSocket HTTP ${response.statusCode}: ${body || "<empty body>"}`));
      });
      response.on("error", () => finishReject(new Error(`${label} WebSocket HTTP ${response.statusCode}: response body read failed`)));
    });
    ws.once("close", (code, reason) => finishReject(new Error(`${label} WebSocket closed before open: ${code} ${String(reason)}`)));
  });
}

async function waitForMessage(
  ws: WebSocket,
  messages: Record<string, unknown>[],
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const existing = messages.find(predicate);
  if (existing) return existing;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for expected WebSocket message"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      messages.push(message);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

async function stopGateway(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (gateway.child.exitCode === null) gateway.child.kill("SIGKILL");
      finish();
    }, 5_000);

    gateway.child.once("exit", finish);
    gateway.child.kill("SIGTERM");
  });
}

run("multi-instance Gateway / PostgreSQL source of truth", () => {
  let fixture: Fixture;
  let gatewayA: GatewayProcess;
  let gatewayB: GatewayProcess;
  let portA: number;
  let portB: number;
  const databaseName = "multi_instance_test";
  const workerSchema = getWorkerSchema();

  beforeAll(async () => {
    await applyMigrations();
    fixture = await seedFixture();

    // The multi-instance test intentionally exercises the public print-job
    // routing path. Give its fixture a real branch/destination/document-type
    // binding so a valid POST reaches job creation instead of correctly
    // returning NO_ROUTE/404.
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1, $2, $3, 'receipt', $4, 1, true)`,
      [`binding_${fixture.printerId}`, fixture.branchId, fixture.destinationId, fixture.printerId],
    );

    gatewayA = startGateway(databaseName, workerSchema);
    gatewayB = startGateway(databaseName, workerSchema);

    [portA, portB] = await Promise.all([
      waitForHealth(gatewayA),
      waitForHealth(gatewayB),
    ]);

    const readinessJobId = `multi-instance-ready-${Date.now()}-${process.pid}`;
    await insertQueuedJob(fixture, readinessJobId);
    const readinessMessages: Record<string, unknown>[] = [];
    const readinessWs = new WebSocket(`ws://127.0.0.1:${portB}/api/agent/ws`, {
      headers: { Authorization: fixture.agentAuth },
    });
    readinessWs.on("message", (data) => {
      readinessMessages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await waitForWebSocketOpen(readinessWs, `Gateway ${portB} readiness`, [gatewayA, gatewayB]);

    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await pool().query("SELECT pg_notify('print_gateway_agent_jobs', $1)", [
          JSON.stringify({ jobId: readinessJobId, agentId: fixture.agentId }),
        ]);
        const row = await pool().query("SELECT status, agent_id FROM print_jobs WHERE id = $1", [readinessJobId]);
        const message = readinessMessages.find((candidate) =>
          candidate.type === "print_job" && (candidate.job as { id?: unknown } | undefined)?.id === readinessJobId,
        );
        if (row.rows[0]?.status === "claimed" && row.rows[0]?.agent_id === fixture.agentId && message) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const row = await pool().query("SELECT status, agent_id FROM print_jobs WHERE id = $1", [readinessJobId]);
      const message = readinessMessages.find((candidate) =>
        candidate.type === "print_job" && (candidate.job as { id?: unknown } | undefined)?.id === readinessJobId,
      );
      expect(row.rows[0]?.status).toBe("claimed");
      expect(row.rows[0]?.agent_id).toBe(fixture.agentId);
      expect(message).toBeDefined();
    } finally {
      readinessWs.close();
      await pool().query("DELETE FROM print_jobs WHERE id = $1", [readinessJobId]);
    }
  });

  beforeEach(async () => {
    await pool().query("DELETE FROM print_jobs");
  });

  afterAll(async () => {
    await Promise.all([stopGateway(gatewayA), stopGateway(gatewayB)]);
    await closePool();
  });

  it("delivers a job created on Gateway A to an agent connected to Gateway B", async () => {
    const messages: Record<string, unknown>[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${portB}/api/agent/ws`, {
      headers: { Authorization: fixture.agentAuth },
    });
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await waitForWebSocketOpen(ws, `Gateway ${portB}`, [gatewayA, gatewayB]);

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
      if (response.status !== 201) {
        throw new Error(`Gateway A POST /api/print/jobs returned HTTP ${response.status}: ${await response.text()}`);
      }
      const created = await response.json() as { id?: string; jobId?: string };
      const createdId = created.id ?? created.jobId;
      expect(createdId).toBeTruthy();

      const message = await waitForMessage(
        ws,
        messages,
        (candidate) => candidate.type === "print_job" && (candidate.job as { id?: unknown } | undefined)?.id === createdId,
        10_000,
      );
      expect(message.type).toBe("print_job");
      expect((message.job as { id: string }).id).toBe(createdId);

      const row = await pool().query("SELECT status, agent_id FROM print_jobs WHERE id = $1", [createdId]);
      expect(row.rows[0]?.status).toBe("claimed");
      expect(row.rows[0]?.agent_id).toBe(fixture.agentId);
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
    wsA.on("message", (data) => messagesA.push(JSON.parse(String(data)) as Record<string, unknown>));
    wsB.on("message", (data) => messagesB.push(JSON.parse(String(data)) as Record<string, unknown>));

    await Promise.all([
      waitForWebSocketOpen(wsA, `Gateway ${portA}`, [gatewayA, gatewayB]),
      waitForWebSocketOpen(wsB, `Gateway ${portB}`, [gatewayA, gatewayB]),
    ]);

    try {
      const deadline = Date.now() + 5_000;
      let winner: "A" | "B" | null = null;
      while (Date.now() < deadline && winner === null) {
        await pool().query("SELECT pg_notify('print_gateway_agent_jobs', $1)", [
          JSON.stringify({ jobId: "multi-claim", agentId: fixture.agentId }),
        ]);
        const countA = messagesA.filter((message) =>
          message.type === "print_job" && (message.job as { id?: unknown } | undefined)?.id === "multi-claim",
        ).length;
        const countB = messagesB.filter((message) =>
          message.type === "print_job" && (message.job as { id?: unknown } | undefined)?.id === "multi-claim",
        ).length;
        if (countA === 1 && countB === 0) winner = "A";
        else if (countA === 0 && countB === 1) winner = "B";
        else if (countA > 1 || countB > 1 || (countA === 1 && countB === 1)) {
          throw new Error(`duplicate multi-instance delivery observed: A=${countA}, B=${countB}`);
        }
        if (winner === null) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(["A", "B"]).toContain(winner);
      const deliveredMessages = [...messagesA, ...messagesB].filter((message) =>
        message.type === "print_job" && (message.job as { id?: unknown } | undefined)?.id === "multi-claim",
      );
      expect(deliveredMessages).toHaveLength(1);

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
