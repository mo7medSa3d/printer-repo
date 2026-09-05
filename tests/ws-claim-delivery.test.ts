import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  jobRow,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { attachAgentWSS, claimAndPushJobToAgent } from "../src/server/ws";
import { claimJobForDelivery, releaseUndeliveredClaim, recordJobAck, MAX_DELIVERY_ATTEMPTS } from "../src/lib/job-delivery";
import { GET as agentJobsGET, PATCH as agentJobsPATCH } from "../src/app/api/agent/jobs/route";

/**
 * PART 1 regression suite — the WebSocket claim race.
 *
 * These tests run against a real PostgreSQL (transactions and
 * FOR UPDATE SKIP LOCKED cannot be simulated) and against the real WebSocket
 * server, with a real `ws` client authenticating as a real agent row.
 */

const suite = describe.skipIf(!hasTestDatabase);

function agentRequest(fixture: Fixture, method: "GET" | "PATCH", body?: unknown) {
  return new Request("http://gateway.test/api/agent/jobs", {
    method,
    headers: {
      Authorization: fixture.agentAuth,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

suite("WS claim-before-delivery", () => {
  let server: Server;
  let port: number;
  let f: Fixture;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    await applyMigrations();
    server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    attachAgentWSS(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const ws of sockets) {
      try { ws.close(); } catch {}
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function connectAgent(fixture: Fixture) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, {
      headers: { Authorization: fixture.agentAuth },
    });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }

  // ---------------------------------------------------------------- Test 1
  it("Test 1: a queued job is claimed BEFORE it is delivered over the WebSocket", async () => {
    const ws = await connectAgent(f);
    await insertQueuedJob(f, "job_t1");

    const observed = new Promise<{ envelope: any; statusWhenReceived: string }>((resolve, reject) => {
      ws.once("message", (data) => {
        const envelope = JSON.parse(data.toString());
        jobRow("job_t1")
          .then((row) => resolve({ envelope, statusWhenReceived: row.status }))
          .catch(reject);
      });
    });

    const outcome = await claimAndPushJobToAgent({ id: "job_t1", agentId: f.agentId });
    expect(outcome).toBe("delivered");

    const { envelope, statusWhenReceived } = await observed;
    expect(statusWhenReceived).toBe("claimed");
    expect(envelope.type).toBe("print_job");
    expect(envelope.job.id).toBe("job_t1");
    expect(envelope.job.status).toBe("claimed");
    expect(envelope.job.agentId).toBe(f.agentId);
    expect(envelope.job.branchId).toBe(f.branchId);
    expect(envelope.job.printerId).toBe(f.printerId);

    const row = await jobRow("job_t1");
    expect(row.status).toBe("claimed");
    expect(row.claimed_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
    expect(row.delivery_attempts).toBe(1);
  });

  it("Test 1b: the agent's job_ack is recorded as receipt and never changes the status", async () => {
    const ws = await connectAgent(f);
    await insertQueuedJob(f, "job_ack");
    const delivered = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    expect(await claimAndPushJobToAgent({ id: "job_ack", agentId: f.agentId })).toBe("delivered");
    await delivered;

    ws.send(JSON.stringify({ type: "job_ack", jobId: "job_ack" }));
    await expect.poll(async () => (await jobRow("job_ack")).acked_at !== null, { timeout: 5000 }).toBe(true);

    const row = await jobRow("job_ack");
    expect(row.status).toBe("claimed"); // ack is receipt, not progress
  });

  it("Test 1c: a late ACK cannot mutate terminal delivery bookkeeping", async () => {
    await insertQueuedJob(f, "job_late_ack");
    await claimJobForDelivery("job_late_ack", f.agentId);
    await pool().query(`UPDATE print_jobs SET status = 'success', acked_at = NULL, delivered_at = NULL WHERE id = 'job_late_ack'`);

    expect(await recordJobAck("job_late_ack", f.agentId)).toBe(false);
    const row = await jobRow("job_late_ack");
    expect(row.status).toBe("success");
    expect(row.acked_at).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  // ---------------------------------------------------------------- Test 2
  it("Test 2: a fast agent cannot move a job queued -> printing/success before the claim", async () => {
    await insertQueuedJob(f, "job_t2");

    const printing = await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }));
    expect(printing.status).toBe(409);
    const success = await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "success" }));
    expect(success.status).toBe(409);
    expect((await jobRow("job_t2")).status).toBe("queued");

    const ws = await connectAgent(f);
    const delivered = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    expect(await claimAndPushJobToAgent({ id: "job_t2", agentId: f.agentId })).toBe("delivered");
    await delivered;

    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }))).status).toBe(200);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "success" }))).status).toBe(200);
    expect((await jobRow("job_t2")).status).toBe("success");
  });

  // ---------------------------------------------------------------- Test 3
  it("Test 3a: with no connected agent nothing is claimed and the job stays queued", async () => {
    await insertQueuedJob(f, "job_t3a");
    expect(await claimAndPushJobToAgent({ id: "job_t3a", agentId: f.agentId })).toBe("no_socket");
    const row = await jobRow("job_t3a");
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
    expect(row.delivery_attempts).toBe(0);
  });

  it("Test 3b: a claim whose delivery fails is requeued under the SAME job id", async () => {
    await insertQueuedJob(f, "job_t3b");

    const claimed = await claimJobForDelivery("job_t3b", f.agentId);
    expect(claimed?.status).toBe("claimed");
    expect((await jobRow("job_t3b")).delivery_attempts).toBe(1);

    const outcome = await releaseUndeliveredClaim("job_t3b", f.agentId, "websocket delivery failed after claim");
    expect(outcome).toBe("requeued");

    const row = await jobRow("job_t3b");
    expect(row.id).toBe("job_t3b");
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
    expect(row.delivered_at).toBeNull();

    const res = await agentJobsGET(agentRequest(f, "GET"));
    const rows = await res.json();
    expect(rows.map((r: any) => r.id)).toContain("job_t3b");
  });

  it("Test 3c: an undeliverable job fails explicitly once the delivery budget is exhausted", async () => {
    await insertQueuedJob(f, "job_t3c");
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      const claimed = await claimJobForDelivery("job_t3c", f.agentId);
      expect(claimed).not.toBeNull();
      const outcome = await releaseUndeliveredClaim("job_t3c", f.agentId, "websocket delivery failed after claim");
      expect(outcome).toBe(i === MAX_DELIVERY_ATTEMPTS - 1 ? "failed" : "requeued");
    }
    const row = await jobRow("job_t3c");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("delivery attempts");
  });

  it("Test 3d: a claimed job that goes silent is reclaimed by the poll path (lease backstop)", async () => {
    await insertQueuedJob(f, "job_t3d");
    await claimJobForDelivery("job_t3d", f.agentId);
    await pool().query(
      `UPDATE print_jobs SET claimed_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' WHERE id = 'job_t3d'`
    );

    const res = await agentJobsGET(agentRequest(f, "GET"));
    const payload = await res.json();
    const rows = Array.isArray(payload) ? payload : Array.isArray((payload as any)?.rows) ? (payload as any).rows : [];
    const reclaimed = rows.find((r: any) => r.id === "job_t3d");
    expect(reclaimed).toBeDefined();
    expect(reclaimed.status).toBe("claimed");

    const row = await jobRow("job_t3d");
    expect(row.retries).toBe(1);
    expect(row.id).toBe("job_t3d");
  });

  // ---------------------------------------------------------------- Test 4
  it("Test 4: a duplicate push does not deliver the job twice", async () => {
    const ws = await connectAgent(f);
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    await insertQueuedJob(f, "job_t4");
    expect(await claimAndPushJobToAgent({ id: "job_t4", agentId: f.agentId })).toBe("delivered");
    expect(await claimAndPushJobToAgent({ id: "job_t4", agentId: f.agentId })).toBe("not_claimable");

    await new Promise((r) => setTimeout(r, 300));
    expect(messages.filter((m) => m.job?.id === "job_t4")).toHaveLength(1);
    expect((await jobRow("job_t4")).delivery_attempts).toBe(1);
  });

  // ---------------------------------------------------------------- Test 5
  it("Test 5: two concurrent claimers cannot claim the same job", async () => {
    await insertQueuedJob(f, "job_t5");
    const [a, b] = await Promise.all([
      claimJobForDelivery("job_t5", f.agentId),
      claimJobForDelivery("job_t5", f.agentId),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect((await jobRow("job_t5")).delivery_attempts).toBe(1);
  });

  it("Test 5b: two concurrent polls never hand the same job to two workers", async () => {
    for (let i = 0; i < 10; i++) await insertQueuedJob(f, `job_t5b_${i}`);
    const [r1, r2] = await Promise.all([
      agentJobsGET(agentRequest(f, "GET")).then((r) => r.json()),
      agentJobsGET(agentRequest(f, "GET")).then((r) => r.json()),
    ]);
    const ids = [...r1.map((r: any) => r.id), ...r2.map((r: any) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
  });

  // ---------------------------------------------------------------- Test 6
  it("Test 6: a terminal job is never claimed or delivered again", async () => {
    const ws = await connectAgent(f);
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    await insertQueuedJob(f, "job_t6");
    await pool().query(`UPDATE print_jobs SET status = 'success', updated_at = now() WHERE id = 'job_t6'`);

    expect(await claimJobForDelivery("job_t6", f.agentId)).toBeNull();
    expect(await claimAndPushJobToAgent({ id: "job_t6", agentId: f.agentId })).toBe("not_claimable");

    const patched = await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t6", status: "printing" }));
    expect(patched.status).toBe(409);

    await new Promise((r) => setTimeout(r, 200));
    expect(messages.filter((m) => m.job?.id === "job_t6")).toHaveLength(0);
    expect((await jobRow("job_t6")).status).toBe("success");
  });

  it("does not claim a job that belongs to another agent or is past its TTL", async () => {
    const other = await seedFixture();
    await insertQueuedJob(f, "job_scope");
    expect(await claimJobForDelivery("job_scope", other.agentId)).toBeNull();
    expect((await jobRow("job_scope")).status).toBe("queued");

    await insertQueuedJob(f, "job_ttl", { expiresInMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await claimJobForDelivery("job_ttl", f.agentId)).toBeNull();
  });
});
