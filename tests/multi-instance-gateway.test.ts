import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { hasTestDatabase, applyMigrations, seedFixture, closePool, pool, insertQueuedJob, type Fixture } from "./helpers/pg";
import { getWorkerSchema } from "../src/lib/worker-schema";

const run = describe.skipIf(!hasTestDatabase || process.env.RUN_MULTI_INSTANCE_TEST !== "1");
type GatewayProcess = { child: ChildProcess; output: () => string; ready: Promise<number> };

function startGateway(workerSchema: string | null): GatewayProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", PORT: "0", HOSTNAME: "127.0.0.1", TRUST_PROXY: "0",
    GATEWAY_JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
    MANAGER_USERNAME: "test-manager", MANAGER_PASSWORD_HASH: "",
  };
  delete env.VITEST; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID;
  if (workerSchema) env.TEST_WORKER_SCHEMA = workerSchema; else delete env.TEST_WORKER_SCHEMA;
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "server.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
  let output = ""; let resolveReady!: (port: number) => void; let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let settled = false;
  const append = (chunk: Buffer | string) => {
    output += String(chunk); if (output.length > 16384) output = output.slice(-16384);
    const match = output.match(/> Ready on http:\/\/127\.0\.0\.1:(\d+) /);
    if (!settled && match) { settled = true; resolveReady(Number(match[1])); }
  };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  child.on("error", (error) => { append(`\n[child error] ${error.message}\n`); if (!settled) { settled = true; rejectReady(error); } });
  child.on("exit", (code, signal) => { if (!settled) { settled = true; rejectReady(new Error(`gateway exited before listening: ${code}/${signal}\n${output}`)); } });
  return { child, output: () => output, ready };
}
async function waitHealthy(gateway: GatewayProcess): Promise<number> {
  const port = await gateway.ready; const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return port; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway ${port} did not become healthy\n${gateway.output()}`);
}
async function openWs(port: number, auth: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, { headers: { Authorization: auth } });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}
async function stop(gateway: GatewayProcess) {
  if (gateway.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { if (gateway.child.exitCode === null) gateway.child.kill("SIGKILL"); resolve(); }, 5000);
    gateway.child.once("exit", () => { clearTimeout(timer); resolve(); }); gateway.child.kill("SIGTERM");
  });
}

run("multi-instance Gateway runtime delivery", () => {
  let fixture: Fixture; let gatewayA: GatewayProcess; let gatewayB: GatewayProcess; let portA: number; let portB: number;
  const schema = getWorkerSchema();

  beforeAll(async () => {
    await applyMigrations(); fixture = await seedFixture();
    gatewayA = startGateway(schema); gatewayB = startGateway(schema);
    [portA, portB] = await Promise.all([waitHealthy(gatewayA), waitHealthy(gatewayB)]);
  });
  beforeEach(async () => { await pool().query("DELETE FROM print_jobs"); });
  afterAll(async () => { await Promise.all([stop(gatewayA), stop(gatewayB)]); await closePool(); });

  it("delivers a queued job to an agent connected to the other Gateway instance", async () => {
    const ws = await openWs(portB, fixture.agentAuth); const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    const jobId = `multi_${Date.now()}`; await insertQueuedJob(fixture, jobId);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !messages.some((m) => m.type === "print_job" && (m.job as any)?.id === jobId)) {
      await pool().query("SELECT pg_notify('print_gateway_agent_jobs', $1)", [JSON.stringify({ jobId, agentId: fixture.agentId })]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const match = messages.filter((m) => m.type === "print_job" && (m.job as any)?.id === jobId);
    expect(match).toHaveLength(1);
    const row = await pool().query("SELECT status, agent_id FROM print_jobs WHERE id=$1", [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "claimed", agent_id: fixture.agentId });
    ws.close();
  });

  it("keeps one job identity when two Gateway instances race delivery", async () => {
    const jobId = "multi-claim"; await insertQueuedJob(fixture, jobId);
    const wsA = await openWs(portA, fixture.agentAuth); const wsB = await openWs(portB, fixture.agentAuth);
    const messagesA: any[] = []; const messagesB: any[] = [];
    wsA.on("message", (data) => messagesA.push(JSON.parse(String(data)))); wsB.on("message", (data) => messagesB.push(JSON.parse(String(data))));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && messagesA.length + messagesB.length === 0) {
      await pool().query("SELECT pg_notify('print_gateway_agent_jobs', $1)", [JSON.stringify({ jobId, agentId: fixture.agentId })]);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const delivered = [...messagesA, ...messagesB].filter((m) => m.type === "print_job" && m.job?.id === jobId);
    expect(delivered).toHaveLength(1);
    const row = await pool().query("SELECT id,status,agent_id FROM print_jobs WHERE id=$1", [jobId]);
    expect(row.rows).toHaveLength(1); expect(row.rows[0]).toMatchObject({ id: jobId, status: "claimed", agent_id: fixture.agentId });
    wsA.close(); wsB.close();
  });
});
