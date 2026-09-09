import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, insertQueuedJob, jobRow, closePool, pool, type Fixture } from "./helpers/pg";
import { attachAgentWSS, claimAndPushJobToAgent } from "../src/server/ws";
import { claimJobForDelivery, releaseUndeliveredClaim, recordJobAck, markJobDelivered, MAX_DELIVERY_ATTEMPTS } from "../src/lib/job-delivery";
import { sweepPrintJobs } from "../src/lib/job-maintenance";
import { GET as agentJobsGET, PATCH as agentJobsPATCH } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);
function agentRequest(f: Fixture, method: "GET" | "PATCH", body?: unknown) {
  return new Request("http://gateway.test/api/agent/jobs", { method, headers: { Authorization: f.agentAuth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

suite("WS claim-before-delivery", () => {
  let server: Server; let port: number; let f: Fixture; const sockets: WebSocket[] = [];
  beforeAll(async () => {
    await applyMigrations();
    server = createServer((_req, res) => res.writeHead(404).end());
    attachAgentWSS(server, { enableJobNotifications: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    sockets.forEach((ws) => { try { ws.close(); } catch {} });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });

  async function connectAgent() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, { headers: { Authorization: f.agentAuth } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return ws;
  }

  it("claims before WebSocket delivery", async () => {
    const ws = await connectAgent();
    await insertQueuedJob(f, "job_t1");
    const observed = new Promise<{ envelope: any; statusWhenReceived: string }>((resolve, reject) => {
      ws.once("message", (data) => jobRow("job_t1").then((row) => resolve({ envelope: JSON.parse(data.toString()), statusWhenReceived: row.status })).catch(reject));
    });
    expect(await claimAndPushJobToAgent({ id: "job_t1", agentId: f.agentId })).toBe("delivered");
    const { envelope, statusWhenReceived } = await observed;
    expect(statusWhenReceived).toBe("claimed");
    expect(envelope.type).toBe("print_job");
    expect(envelope.job.id).toBe("job_t1");
    expect(envelope.job.status).toBe("claimed");
    expect(envelope.job.agentId).toBe(f.agentId);
    expect(envelope.job.printerId).toBe(f.printerId);
    const row = await jobRow("job_t1");
    expect(row.delivery_attempts).toBe(1);
    expect(row.delivered_at).not.toBeNull();
  });

  it("job_ack records receipt without changing print status", async () => {
    const ws = await connectAgent();
    await insertQueuedJob(f, "job_ack");
    const delivered = new Promise<void>((resolve) => ws.once("message", resolve));
    expect(await claimAndPushJobToAgent({ id: "job_ack", agentId: f.agentId })).toBe("delivered");
    await delivered;
    ws.send(JSON.stringify({ type: "job_ack", jobId: "job_ack" }));
    await expect.poll(async () => (await jobRow("job_ack")).acked_at !== null, { timeout: 5000 }).toBe(true);
    expect((await jobRow("job_ack")).status).toBe("claimed");
  });

  it("late ACK cannot mutate terminal delivery bookkeeping", async () => {
    await insertQueuedJob(f, "job_late_ack");
    await claimJobForDelivery("job_late_ack", f.agentId);
    await pool().query(`UPDATE print_jobs SET status='success', acked_at=NULL, delivered_at=NULL WHERE id='job_late_ack'`);
    expect(await recordJobAck("job_late_ack", f.agentId)).toBe(false);
    const row = await jobRow("job_late_ack");
    expect(row.status).toBe("success");
    expect(row.acked_at).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  it("rejects progress before claim", async () => {
    await insertQueuedJob(f, "job_t2");
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }))).status).toBe(409);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "success" }))).status).toBe(409);
    expect((await jobRow("job_t2")).status).toBe("queued");
    const ws = await connectAgent();
    const delivered = new Promise<string>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()).job.claimToken as string)));
    expect(await claimAndPushJobToAgent({ id: "job_t2", agentId: f.agentId })).toBe("delivered");
    const token = await delivered;
    // Reports without (or with a wrong) claim token are fenced out.
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }))).status).toBe(409);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing", claimToken: token + "wrong" }))).status).toBe(409);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing", claimToken: token }))).status).toBe(200);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "success", claimToken: token }))).status).toBe(200);
  });

  it("without a connected agent, job remains queued", async () => {
    await insertQueuedJob(f, "job_t3a");
    expect(await claimAndPushJobToAgent({ id: "job_t3a", agentId: f.agentId })).toBe("no_socket");
    const row = await jobRow("job_t3a");
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
    expect(row.delivery_attempts).toBe(0);
  });

  it("delivery failure requeues under the same job id", async () => {
    await insertQueuedJob(f, "job_t3b");
    expect((await claimJobForDelivery("job_t3b", f.agentId))?.status).toBe("claimed");
    expect((await releaseUndeliveredClaim("job_t3b", f.agentId, "websocket delivery failed after claim"))).toBe("requeued");
    const row = await jobRow("job_t3b");
    expect(row.id).toBe("job_t3b");
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
  });

  it("undeliverable job fails when delivery budget is exhausted", async () => {
    await insertQueuedJob(f, "job_t3c");
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      expect(await claimJobForDelivery("job_t3c", f.agentId)).not.toBeNull();
      expect(await releaseUndeliveredClaim("job_t3c", f.agentId, "websocket delivery failed after claim")).toBe(i === MAX_DELIVERY_ATTEMPTS - 1 ? "failed" : "requeued");
    }
    const row = await jobRow("job_t3c");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("delivery attempts");
  });

  it("stale claimed job is reclaimed by the poll path", async () => {
    await insertQueuedJob(f, "job_t3d");
    await claimJobForDelivery("job_t3d", f.agentId);
    await pool().query(`UPDATE print_jobs SET claimed_at=now()-interval '200 seconds', updated_at=now()-interval '200 seconds' WHERE id='job_t3d'`);
    const payload = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    const reclaimed = payload.find((r: any) => r.id === "job_t3d");
    expect(reclaimed).toBeDefined();
    expect(reclaimed.status).toBe("claimed");
    expect((await jobRow("job_t3d")).retries).toBe(1);
  });

  it("duplicate push cannot deliver the same job twice", async () => {
    const ws = await connectAgent();
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await insertQueuedJob(f, "job_t4");
    expect(await claimAndPushJobToAgent({ id: "job_t4", agentId: f.agentId })).toBe("delivered");
    expect(await claimAndPushJobToAgent({ id: "job_t4", agentId: f.agentId })).toBe("not_claimable");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages.filter((m) => m.job?.id === "job_t4")).toHaveLength(1);
    expect((await jobRow("job_t4")).delivery_attempts).toBe(1);
  });

  it("two concurrent claimers cannot claim the same job", async () => {
    await insertQueuedJob(f, "job_t5");
    const [a, b] = await Promise.all([claimJobForDelivery("job_t5", f.agentId), claimJobForDelivery("job_t5", f.agentId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await jobRow("job_t5")).delivery_attempts).toBe(1);
  });

  it("fencing: a stale worker cannot finalize a job re-claimed by a new attempt", async () => {
    // Phase-9 scenario across independent transactions:
    // worker A claims (token A) and stalls undelivered -> lease expires ->
    // poll reclaims with a FRESH token -> A's stale reports are rejected by
    // the DB ownership predicate, while the new holder remains authoritative.
    await insertQueuedJob(f, "job_fence");
    const claimA = await claimJobForDelivery("job_fence", f.agentId);
    expect(claimA?.claimToken).toBeTruthy();
    await pool().query(`UPDATE print_jobs SET claimed_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' WHERE id = 'job_fence'`);
    const pollRes = await agentJobsGET(agentRequest(f, "GET"));
    const rows = await pollRes.json();
    const reclaimed = rows.find((r: any) => r.id === "job_fence");
    expect(reclaimed).toBeDefined();
    expect(reclaimed.claimToken).toBeTruthy();
    expect(reclaimed.claimToken).not.toBe(claimA!.claimToken);
    // The dead attempt reports success -> rejected, and it does not move the job.
    const stale = await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_fence", status: "printing", claimToken: claimA!.claimToken }));
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody.code).toBe("STALE_CLAIM");
    expect((await jobRow("job_fence")).status).toBe("claimed");
    // The live attempt proceeds normally.
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_fence", status: "printing", claimToken: reclaimed.claimToken }))).status).toBe(200);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_fence", status: "success", claimToken: reclaimed.claimToken }))).status).toBe(200);
    expect((await jobRow("job_fence")).status).toBe("success");
  });

  it("a DELIVERED stale claim is never re-queued; it fails with an unknown-outcome marker", async () => {
    await insertQueuedJob(f, "job_del_stale");
    const claim = await claimJobForDelivery("job_del_stale", f.agentId);
    await markJobDelivered("job_del_stale", f.agentId);
    await pool().query(`UPDATE print_jobs SET claimed_at = now() - interval '200 seconds', delivered_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' WHERE id = 'job_del_stale'`);
    const sweep = await sweepPrintJobs({ agentId: f.agentId });
    expect(sweep.silentDeliveries).toBeGreaterThanOrEqual(1);
    const row = await jobRow("job_del_stale");
    expect(row.status).toBe("failed");
    // The marker is what keeps Odoo/desktop from ever calling this "definitely
    // not printed": it must be terminal and unknown-outcome.
    expect(row.error).toMatch(/^UNKNOWN_PARTIAL_DELIVERY/);
    expect(claim?.claimToken).toBeTruthy();
    // And the poll path must not re-deliver it either.
    const poll = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    expect(poll.find((r: any) => r.id === "job_del_stale")).toBeUndefined();
  });

  it("two concurrent polls do not duplicate jobs", async () => {
    for (let i = 0; i < 10; i += 1) await insertQueuedJob(f, `job_t5b_${i}`);
    const [r1, r2] = await Promise.all([
      agentJobsGET(agentRequest(f, "GET")).then((r) => r.json()),
      agentJobsGET(agentRequest(f, "GET")).then((r) => r.json()),
    ]);
    const ids = [...r1.map((r: any) => r.id), ...r2.map((r: any) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
  });

  it("terminal job is never claimed again", async () => {
    const ws = await connectAgent();
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await insertQueuedJob(f, "job_t6");
    await pool().query(`UPDATE print_jobs SET status='success', updated_at=now() WHERE id='job_t6'`);
    expect(await claimJobForDelivery("job_t6", f.agentId)).toBeNull();
    expect(await claimAndPushJobToAgent({ id: "job_t6", agentId: f.agentId })).toBe("not_claimable");
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t6", status: "printing" }))).status).toBe(409);
    await new Promise((r) => setTimeout(r, 200));
    expect(messages.filter((m) => m.job?.id === "job_t6")).toHaveLength(0);
  });

  it("does not claim jobs owned by another agent or past TTL", async () => {
    const other = await seedFixture();
    await insertQueuedJob(f, "job_scope");
    expect(await claimJobForDelivery("job_scope", other.agentId)).toBeNull();
    expect((await jobRow("job_scope")).status).toBe("queued");
    await insertQueuedJob(f, "job_ttl", { expiresInMs: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await claimJobForDelivery("job_ttl", f.agentId)).toBeNull();
  });
});
