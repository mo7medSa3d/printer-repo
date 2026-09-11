import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, insertQueuedJob, jobRow, closePool, pool, type Fixture } from "./helpers/pg";
import { attachAgentWSS, claimAndPushJobToAgent } from "../src/server/ws";
import { db } from "../src/db";
import { claimJobForDelivery, releaseUndeliveredClaim, recordJobAck, MAX_DELIVERY_ATTEMPTS, MAX_AGENT_IN_FLIGHT_JOBS } from "../src/lib/job-delivery";
import type { ClaimedJobRow } from "../src/lib/job-delivery";
import { sweepPrintJobs } from "../src/lib/job-maintenance";
import { GET as agentJobsGET, PATCH as agentJobsPATCH } from "../src/app/api/agent/jobs/route";

// Delivery-evidence hook: claimAndPushJobToAgent must report "delivered"
// ONLY when the delivered_at write persists for the same claim token -
// never on socket success alone. Tests redirect the evidence write here.
// (The real implementation is stashed on globalThis because this file's own
// static import resolves through the mock below.)
type MarkFn = (jobId: string, agentId: string, claimToken: string | null) => Promise<boolean>;
vi.mock("../src/lib/job-delivery", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/job-delivery")>();
  (globalThis as unknown as { __realMarkJobDelivered: MarkFn }).__realMarkJobDelivered = mod.markJobDelivered;
  return {
    ...mod,
    markJobDelivered: async (...args: Parameters<MarkFn>) => {
      const hook = (globalThis as unknown as { __markEvidenceImpl?: MarkFn }).__markEvidenceImpl;
      return hook ? hook(...args) : mod.markJobDelivered(...args);
    },
  };
});
const realMarkJobDelivered = (...args: Parameters<MarkFn>): Promise<boolean> =>
  (globalThis as unknown as { __realMarkJobDelivered: MarkFn }).__realMarkJobDelivered(...args);

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
    const delivered = new Promise<{ claimToken?: string }>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)).job ?? {})));
    expect(await claimAndPushJobToAgent({ id: "job_ack", agentId: f.agentId })).toBe("delivered");
    const envelope = await delivered;
    // A tokenless ack (legacy/superseded frame) must NOT be adopted by a
    // tokenized live claim.
    expect(await recordJobAck("job_ack", f.agentId)).toBe(false);
    expect((await jobRow("job_ack")).acked_at).toBeNull();
    ws.send(JSON.stringify({ type: "job_ack", jobId: "job_ack", claimToken: envelope.claimToken }));
    await expect.poll(async () => (await jobRow("job_ack")).acked_at !== null, { timeout: 5000 }).toBe(true);
    expect((await jobRow("job_ack")).status).toBe("claimed");
  });

  it("a forged ack cannot stamp delivery evidence onto a live claim", async () => {
    await insertQueuedJob(f, "job_ack_forged");
    const claim = await claimJobForDelivery("job_ack_forged", f.agentId);
    expect(claim!.claimToken).toBeTruthy();
    expect(await recordJobAck("job_ack_forged", f.agentId, "forged-token")).toBe(false);
    expect(await recordJobAck("job_ack_forged", f.agentId)).toBe(false);
    const row = await jobRow("job_ack_forged");
    expect(row.acked_at).toBeNull();
    expect(row.delivered_at).toBeNull();
    expect(row.status).toBe("claimed");
    expect(await recordJobAck("job_ack_forged", f.agentId, claim!.claimToken)).toBe(true);
    expect((await jobRow("job_ack_forged")).acked_at).not.toBeNull();
  });

  it("late ACK cannot mutate terminal delivery bookkeeping", async () => {
    await insertQueuedJob(f, "job_late_ack");
    const lateClaim = await claimJobForDelivery("job_late_ack", f.agentId);
    await pool().query(`UPDATE print_jobs SET status='success', acked_at=NULL, delivered_at=NULL WHERE id='job_late_ack'`);
    expect(await recordJobAck("job_late_ack", f.agentId, lateClaim!.claimToken)).toBe(false);
    const row = await jobRow("job_late_ack");
    expect(row.status).toBe("success");
    expect(row.acked_at).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  it("rejects progress before claim", async () => {
    await insertQueuedJob(f, "job_t2");
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }))).status).toBe(409);
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "success" }))).status).toBe(409);
    // Tokenless attempts against an UNDELIVERED queued claim: the row has a
    // token from the claim, so these are STALE_CLAIM rejections too.
    expect(((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_t2", status: "printing" }))) as Response).status).toBe(409);
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
    const claim = await claimJobForDelivery("job_t3b", f.agentId);
    expect(claim?.status).toBe("claimed");
    // A WRONG token must not release someone else's claim.
    expect(await releaseUndeliveredClaim("job_t3b", f.agentId, "forged-token", "websocket delivery failed after claim")).toBe("noop");
    expect((await jobRow("job_t3b")).status).toBe("claimed");
    expect(await releaseUndeliveredClaim("job_t3b", f.agentId, claim!.claimToken, "websocket delivery failed after claim")).toBe("requeued");
    const row = await jobRow("job_t3b");
    expect(row.id).toBe("job_t3b");
    expect(row.status).toBe("queued");
    expect(row.claimed_at).toBeNull();
  });

  it("undeliverable job fails when delivery budget is exhausted", async () => {
    await insertQueuedJob(f, "job_t3c");
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      const claim = await claimJobForDelivery("job_t3c", f.agentId);
      expect(claim).not.toBeNull();
      expect(await releaseUndeliveredClaim("job_t3c", f.agentId, claim!.claimToken, "websocket delivery failed after claim")).toBe(i === MAX_DELIVERY_ATTEMPTS - 1 ? "failed" : "requeued");
    }
    const row = await jobRow("job_t3c");
    expect(row.status).toBe("failed");
    expect(row.error).toContain("delivery attempts");
  });

  it("lost poll response recovers safely with no false delivery evidence", async () => {
    // Failure injection: the poll claim commits, but the HTTP response
    // never reaches the agent (connection dies mid-response). claimed !=
    // delivered, so the sweep must REQUEUE (safe: provably no execution
    // report exists) rather than fail the job as unknown - and a later
    // poll must reclaim it under a fresh token with still no delivered_at.
    await insertQueuedJob(f, "job_lost_poll");
    const first = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    const lost = first.find((r: any) => r.id === "job_lost_poll");
    expect(lost).toBeDefined();
    expect(lost.status).toBe("claimed");
    expect(lost.claimToken).toBeTruthy();
    // ... the response is lost here: the agent never sees it ...
    let row = await jobRow("job_lost_poll");
    expect(row.delivered_at).toBeNull();
    expect(row.acked_at).toBeNull();
    await pool().query(`UPDATE print_jobs SET claimed_at = now() - interval '200 seconds', updated_at = now() - interval '200 seconds' WHERE id = 'job_lost_poll'`);
    const swept = await sweepPrintJobs({ agentId: f.agentId });
    expect(swept.requeuedClaims).toBeGreaterThanOrEqual(1);
    expect(swept.silentDeliveries).toBe(0);
    row = await jobRow("job_lost_poll");
    expect(row.status).toBe("queued");
    expect(row.delivered_at).toBeNull();
    expect((row.error as string | null) ?? "").not.toMatch(/UNKNOWN_PARTIAL_DELIVERY/);
    const second = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    const reclaimed = second.find((r: any) => r.id === "job_lost_poll");
    expect(reclaimed).toBeDefined();
    expect(reclaimed.claimToken).toBeTruthy();
    expect(reclaimed.claimToken).not.toBe(lost.claimToken);
    expect((await jobRow("job_lost_poll")).delivered_at).toBeNull();
  });

  it("pre-execution rejection clears all attempt delivery evidence", async () => {
    // A WS-delivered claim returned via pending_full must come back with
    // NO surviving attempt evidence (token, delivered_at, acked_at,
    // claimed_at): the row must unambiguously mean "safe to redeliver,
    // nothing was physically dispatched" - and must actually be
    // reclaimable afterwards under a fresh token.
    await insertQueuedJob(f, "job_reject_evidence");
    const claim = await claimJobForDelivery("job_reject_evidence", f.agentId);
    await realMarkJobDelivered("job_reject_evidence", f.agentId, claim!.claimToken);
    await pool().query(`UPDATE print_jobs SET acked_at = now() WHERE id = 'job_reject_evidence'`);
    const res = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_reject_evidence", status: "queued", reason: "pending_full", claimToken: claim!.claimToken,
    }));
    expect(res.status).toBe(200);
    const row = await jobRow("job_reject_evidence");
    expect(row.status).toBe("queued");
    expect(row.claim_token).toBeNull();
    expect(row.delivered_at).toBeNull();
    expect(row.acked_at).toBeNull();
    expect(row.claimed_at).toBeNull();
    const next = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    const reclaimed = next.find((r: any) => r.id === "job_reject_evidence");
    expect(reclaimed).toBeDefined();
    expect(reclaimed.claimToken).toBeTruthy();
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

  it("socket success without persisted evidence is NOT a delivery", async () => {
    // The socket write succeeds, but the delivered_at evidence write for
    // the same claim token fails (row expired/terminal mid-send). The
    // gateway must NOT report "delivered" on the socket alone: it falls
    // back to the fenced release path instead of stranding a phantom
    // delivery that the agent actually holds.
    const ws = await connectAgent();
    const messages: unknown[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await insertQueuedJob(f, "job_phantom");
    (globalThis as unknown as { __markEvidenceImpl?: MarkFn }).__markEvidenceImpl = async () => false;
    try {
      expect(await claimAndPushJobToAgent({ id: "job_phantom", agentId: f.agentId })).toBe("requeued");
    } finally {
      delete (globalThis as unknown as { __markEvidenceImpl?: MarkFn }).__markEvidenceImpl;
    }
    const row = await jobRow("job_phantom");
    expect(row.status).toBe("queued");
    expect(row.delivered_at).toBeNull();
    expect(row.claim_token).toBeNull();
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
    await realMarkJobDelivered("job_del_stale", f.agentId, claim!.claimToken);
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

  it("TOCTOU: a reclaim racing between the route read and its UPDATE cannot be clobbered", async () => {
    // Deterministic reproduction of the adversarial sequence:
    //   1. worker A claims (token A) and is still authoritative when the
    //      route READS the row,
    //   2. between that read and the route's UPDATE, the lease is reclaimed
    //      by another attempt (token B, status back to 'claimed'),
    //   3. A's "printing" UPDATE must match ZERO rows in PostgreSQL.
    // If the claim_token predicate were removed from the production
    // statement (fencedJobWrite), this UPDATE would clobber token B's claim
    // and the test turns red with status=printing.
    await insertQueuedJob(f, "job_toctou");
    const claimA = await claimJobForDelivery("job_toctou", f.agentId);
    const staleToken = claimA!.claimToken!;

    const queryTarget = db.query.printJobs as unknown as { findFirst: (q?: unknown) => Promise<Record<string, unknown> | undefined> };
    const originalFindFirst = queryTarget.findFirst.bind(db.query.printJobs);
    let flipped = false;
    queryTarget.findFirst = async (query?: unknown) => {
      const row = await originalFindFirst(query);
      if (!flipped) {
        flipped = true;
        // The reclaim lands AFTER the route's read and BEFORE its write.
        await pool().query(
          `UPDATE print_jobs SET status='claimed', claim_token='reclaim-worker-b', updated_at=now() WHERE id='job_toctou'`,
        );
      }
      return row;
    };
    try {
      const res = await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_toctou", status: "printing", claimToken: staleToken }));
      expect(res.status).toBe(409);
    } finally {
      queryTarget.findFirst = originalFindFirst;
    }
    const row = await jobRow("job_toctou");
    expect(row.status).toBe("claimed");
    expect(row.claim_token).toBe("reclaim-worker-b");
    // The live attempt (token B) still owns the job and can proceed.
    expect((await agentJobsPATCH(agentRequest(f, "PATCH", { jobId: "job_toctou", status: "printing", claimToken: "reclaim-worker-b" }))).status).toBe(200);
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

  it("pre-execution rejection refunds the delivery budget and consumes the retry budget", async () => {
    // LAW 9: a rejected job transmitted ZERO bytes, so it must not burn the
    // physical-delivery-attempt ceiling. It DOES consume one retry (bounded).
    await insertQueuedJob(f, "job_budget");
    const claim = await claimJobForDelivery("job_budget", f.agentId);
    expect(claim).not.toBeNull();
    expect((await jobRow("job_budget")).delivery_attempts).toBe(1);
    const reject = () => agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_budget", status: "queued", reason: "pending_full", claimToken: claim!.claimToken,
    }));
    // token cleared after first rejection: second reject carries the NEW token
    expect((await reject()).status).toBe(200);
    let row = await jobRow("job_budget");
    expect(row.status).toBe("queued");
    expect(row.delivery_attempts).toBe(0);
    expect(row.retries).toBe(1);
    const claim2 = await claimJobForDelivery("job_budget", f.agentId);
    expect(claim2).not.toBeNull();
    row = await jobRow("job_budget");
    expect(row.delivery_attempts).toBe(1);
    expect(row.retries).toBe(1);
    // a stale duplicate rejection with the superseded token cannot refund twice
    await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_budget", status: "queued", reason: "pending_full", claimToken: claim!.claimToken,
    }));
    row = await jobRow("job_budget");
    expect(row.status).toBe("claimed");
    expect(row.retries).toBe(1);
    // the fresh-token rejection refunds and counts again
    const reject2 = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_budget", status: "queued", reason: "agent_shutting_down", claimToken: claim2!.claimToken,
    }));
    expect(reject2.status).toBe(200);
    row = await jobRow("job_budget");
    expect(row.delivery_attempts).toBe(0);
    expect(row.retries).toBe(2);
  });

  it("rejections cannot exhaust the delivery budget but stay bounded by retries", async () => {
    await insertQueuedJob(f, "job_bounded");
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const claim = await claimJobForDelivery("job_bounded", f.agentId);
      expect(claim, `cycle ${cycle} must be claimable`).not.toBeNull();
      const res = await agentJobsPATCH(agentRequest(f, "PATCH", {
        jobId: "job_bounded", status: "queued", reason: "pending_full", claimToken: claim!.claimToken,
      }));
      expect(res.status).toBe(200);
    }
    const row = await jobRow("job_bounded");
    expect(row.delivery_attempts).toBe(0);
    expect(row.retries).toBe(5);
    // 6th cycle blocked by the retry budget - and the delivery budget stayed
    // intact, so a healthy agent returning within TTL still gets the job.
    expect(await claimJobForDelivery("job_bounded", f.agentId)).toBeNull();
    const poll = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    expect(poll.find((r: any) => r.id === "job_bounded")).toBeUndefined();
    expect((await jobRow("job_bounded")).status).toBe("queued");
  });

  it("undelivered-claim release still consumes the delivery budget", async () => {
    // Contrast case: a claim whose socket send FAILED is a real (ambiguous)
    // delivery hand-off and must burn delivery_attempts, never retries.
    await insertQueuedJob(f, "job_release");
    const claim = await claimJobForDelivery("job_release", f.agentId);
    const outcome = await releaseUndeliveredClaim("job_release", f.agentId, claim!.claimToken, "websocket delivery failed after claim; job requeued for redelivery");
    expect(outcome).toBe("requeued");
    const row = await jobRow("job_release");
    expect(row.status).toBe("queued");
    expect(row.delivery_attempts).toBe(1);
    expect(row.retries).toBe(0);
  });

  it("expiry never fabricates delivery evidence", async () => {
    // LAW 8: no evidence -> no delivered_at, regardless of which path expires.
    await insertQueuedJob(f, "job_exp_qu");
    await insertQueuedJob(f, "job_exp_cl");
    await insertQueuedJob(f, "job_exp_ev");
    const c2 = await claimJobForDelivery("job_exp_cl", f.agentId);
    expect(c2).not.toBeNull();
    const c3 = await claimJobForDelivery("job_exp_ev", f.agentId);
    expect(c3).not.toBeNull();
    await realMarkJobDelivered("job_exp_ev", f.agentId, c3!.claimToken);
    await pool().query(`UPDATE print_jobs SET expires_at = now() - interval '1 second' WHERE id IN ('job_exp_qu','job_exp_cl','job_exp_ev')`);
    await sweepPrintJobs();
    const q = await jobRow("job_exp_qu");
    expect(q.status).toBe("expired");
    expect(q.delivered_at).toBeNull();
    expect(q.error).toBeNull();
    const cl = await jobRow("job_exp_cl");
    expect(cl.status).toBe("expired");
    expect(cl.delivered_at).toBeNull(); // claimed but provably never delivered
    expect(cl.error).toBeNull();
    const ev = await jobRow("job_exp_ev");
    expect(ev.status).toBe("expired");
    expect(ev.error).toMatch(/^UNKNOWN_PARTIAL_DELIVERY/);
    expect(ev.delivered_at).not.toBeNull(); // pre-existing evidence survives, not fabricated
  });

  it("agent-observed expiry of a held claim stamps evidence and marks unknown", async () => {
    // A fenced agent report PROVES possession (LAW 8: real evidence source),
    // so the expiry branch may stamp delivered_at; a printing row that then
    // expires past its TTL is terminal with the unknown outcome marker.
    await insertQueuedJob(f, "job_exp_print");
    const claim = await claimJobForDelivery("job_exp_print", f.agentId);
    const printing = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_exp_print", status: "printing", claimToken: claim!.claimToken,
    }));
    expect(printing.status).toBe(200);
    await pool().query(`UPDATE print_jobs SET expires_at = now() - interval '1 second' WHERE id = 'job_exp_print'`);
    // The agent explicitly reports expiry: the dedicated expired branch
    // terminalizes the row (never the generic success write), stamping
    // delivery evidence because the fenced report proved the hold.
    const expired = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_exp_print", status: "expired", claimToken: claim!.claimToken,
    }));
    expect(expired.status).toBe(200); // explicit expiry acknowledgement
    const body = await expired.json();
    expect(body.status).toBe("expired");
    expect(body.physicalOutcome).toBe("unknown");
    const row = await jobRow("job_exp_print");
    expect(row.status).toBe("expired");
    expect(row.error).toMatch(/^JOB_EXPIRED_DURING_PRINT/);
    expect(row.delivered_at).not.toBeNull(); // justified: fenced report proved the hold
  });

  it("agent success within the post-expiry grace window records PRINTED_POST_EXPIRATION", async () => {
    // A print physically completed right at the TTL boundary: the row was
    // already terminalized to expired by the sweep (expiry 1s ago, inside
    // EXPIRED_LATE_SUCCESS_GRACE_MS), then the claim holder reports the
    // completed print. Recorded as success with PRINTED_POST_EXPIRATION
    // rather than a blind 409.
    await insertQueuedJob(f, "job_exp_late_success");
    const claim = await claimJobForDelivery("job_exp_late_success", f.agentId);
    const printing = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_exp_late_success", status: "printing", claimToken: claim!.claimToken,
    }));
    expect(printing.status).toBe(200);
    await pool().query(`UPDATE print_jobs SET expires_at = now() - interval '1 second' WHERE id = 'job_exp_late_success'`);
    await sweepPrintJobs();
    const swept = await jobRow("job_exp_late_success");
    expect(swept.status).toBe("expired");
    const late = await agentJobsPATCH(agentRequest(f, "PATCH", {
      jobId: "job_exp_late_success", status: "success", claimToken: claim!.claimToken,
    }));
    expect(late.status).toBe(200);
    const body = await late.json();
    expect(body.status).toBe("success");
    expect(body.physicalOutcome).toBe("printed");
    expect(body.physicalDetail).toBe("PRINTED_POST_EXPIRATION");
    const row = await jobRow("job_exp_late_success");
    expect(row.status).toBe("success");
    expect(row.error).toMatch(/^PRINTED_POST_EXPIRATION/);
    expect(row.delivered_at).not.toBeNull();
  });

  it("poll stale-reclaim refuses a job at the delivery-attempt ceiling without claiming it", async () => {
    // FIX-1 regression: stale_candidates enforced only the RETRY budget, so
    // a reclaim could push delivery_attempts past MAX_DELIVERY_ATTEMPTS -
    // the ceiling every other claim path enforces ("no path can claim a job
    // past its ceilings"). Reclaiming beyond the ceiling re-opens ambiguous
    // hand-offs indefinitely.
    await insertQueuedJob(f, "job_stale_ceiling");
    await insertQueuedJob(f, "job_ceiling_other");
    const staleClaim = await claimJobForDelivery("job_stale_ceiling", f.agentId);
    expect(staleClaim).not.toBeNull();
    const tokenBefore = staleClaim!.claimToken;
    await pool().query(
      `UPDATE print_jobs SET delivery_attempts = ${MAX_DELIVERY_ATTEMPTS}, retries = 0, updated_at = now() - interval '2 minutes' WHERE id = 'job_stale_ceiling'`,
    );
    const rows = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    // Not (re)claimed by the poll - no envelope for it in this response.
    expect(rows.find((r: any) => r.id === "job_stale_ceiling")).toBeUndefined();
    const after = await jobRow("job_stale_ceiling");
    // delivery_attempts was NOT incremented past the ceiling.
    expect(Number(after.delivery_attempts)).toBe(MAX_DELIVERY_ATTEMPTS);
    // And the attempt was never re-tokenized: either the lease sweep
    // returned it to 'queued' (token cleared - also blocked from claiming
    // by this very ceiling) or it remains the ORIGINAL claim untouched.
    if (after.status === "claimed") {
      expect(after.claim_token).toBe(tokenBefore);
    } else {
      expect(after.status).toBe("queued");
      expect(after.claim_token).toBeNull();
    }
    // Unrelated eligible jobs are still claimable by the same poll.
    expect(rows.find((r: any) => r.id === "job_ceiling_other")).toBeTruthy();
  });

  it("a ceiling-exhausted stale claim terminates via requeue then expiry, never stuck invisible", async () => {
    // PHASE 4 lifecycle proof: delivery_attempts >= MAX with retries < MAX
    // must not strand. The sweep requeues the provably-undelivered claim,
    // both claim boundaries then refuse it (ceiling), and TTL expiry drives
    // it to a terminal outcome with no fabricated evidence.
    await insertQueuedJob(f, "job_ceiling_lifecycle");
    const claim = await claimJobForDelivery("job_ceiling_lifecycle", f.agentId);
    expect(claim).not.toBeNull();
    await pool().query(
      `UPDATE print_jobs SET delivery_attempts = ${MAX_DELIVERY_ATTEMPTS}, retries = 0, updated_at = now() - interval '2 minutes' WHERE id = 'job_ceiling_lifecycle'`,
    );
    await sweepPrintJobs({ agentId: f.agentId });
    let row = await jobRow("job_ceiling_lifecycle");
    expect(row.status).toBe("queued"); // T8 requeued the stale no-evidence claim
    expect(row.claim_token).toBeNull();
    expect(Number(row.delivery_attempts)).toBe(MAX_DELIVERY_ATTEMPTS);

    expect(await claimJobForDelivery("job_ceiling_lifecycle", f.agentId)).toBeNull();
    const poll = await (await agentJobsGET(agentRequest(f, "GET"))).json();
    expect(poll.find((r: any) => r.id === "job_ceiling_lifecycle")).toBeUndefined();
    row = await jobRow("job_ceiling_lifecycle");
    expect(row.status).toBe("queued"); // never reclaimed

    // TTL expiry makes the fate explicit and terminal.
    await pool().query(`UPDATE print_jobs SET expires_at = now() - interval '1 second' WHERE id = 'job_ceiling_lifecycle'`);
    await sweepPrintJobs();
    row = await jobRow("job_ceiling_lifecycle");
    expect(row.status).toBe("expired");
    expect(row.delivered_at).toBeNull(); // no evidence existed, none fabricated
    expect(row.error).toBeNull(); // unheld claim: not_printed derivation is honest
  });

  it("WebSocket claim refuses at the ceiling and leaves the row untouched", async () => {
    // FIX-3 ceiling enforcement proof for the WS boundary (the contract
    // documented in job-delivery.ts): a job whose hand-off budget is spent
    // cannot be claimed, and the refusal mutates nothing.
    await insertQueuedJob(f, "job_ws_ceiling");
    await pool().query(`UPDATE print_jobs SET delivery_attempts = ${MAX_DELIVERY_ATTEMPTS} WHERE id = 'job_ws_ceiling'`);
    expect(await claimJobForDelivery("job_ws_ceiling", f.agentId)).toBeNull();
    const row = await jobRow("job_ws_ceiling");
    expect(row.status).toBe("queued");
    expect(Number(row.delivery_attempts)).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(row.claim_token).toBeNull();
  });

  it("WS claim enforces the in-flight ceiling: saturated agent gets no new claim", async () => {
    // The 500 in-flight cap used to be creation- and poll-only: concurrent
    // WS pushes (NOTIFY fan-out, bulk creation) could overshoot it without
    // bound. Fill the agent to exactly the ceiling with live claimed rows,
    // then prove the next WS claim is refused without touching the row.
    await pool().query(
      `INSERT INTO print_jobs (id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
       SELECT 'cap_fill_' || g, $1, 'receipt', $2, $3, 'claimed',
              '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb,
              now() + interval '1 hour'
       FROM generate_series(1, $4) g`,
      [f.destination, f.agentId, f.printerId, MAX_AGENT_IN_FLIGHT_JOBS],
    );
    await insertQueuedJob(f, "job_cap_saturated");
    expect(await claimJobForDelivery("job_cap_saturated", f.agentId)).toBeNull();
    const row = await jobRow("job_cap_saturated");
    expect(row.status).toBe("queued");
    expect(Number(row.delivery_attempts)).toBe(0);
    expect(row.claim_token).toBeNull();
  });

  it("concurrent WS claims at the cap boundary admit exactly one (advisory-lock serialization)", async () => {
    // One slot below the ceiling, two simultaneous pushes must not both
    // win: the shared pg_advisory_xact_lock serializes the count+claim, so
    // exactly one claim lands and delivery_attempts increments exactly once
    // across both rows. Against the old uncapped code both would claim.
    await pool().query(
      `INSERT INTO print_jobs (id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
       SELECT 'cap_race_' || g, $1, 'receipt', $2, $3, 'claimed',
              '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb,
              now() + interval '1 hour'
       FROM generate_series(1, $4) g`,
      [f.destination, f.agentId, f.printerId, MAX_AGENT_IN_FLIGHT_JOBS - 1],
    );
    await insertQueuedJob(f, "job_cap_race_a");
    await insertQueuedJob(f, "job_cap_race_b");
    const [a, b] = await Promise.all([
      claimJobForDelivery("job_cap_race_a", f.agentId),
      claimJobForDelivery("job_cap_race_b", f.agentId),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    const sum = await pool().query(
      `SELECT COALESCE(SUM(delivery_attempts), 0)::int AS s FROM print_jobs WHERE id IN ('job_cap_race_a','job_cap_race_b')`,
    );
    expect(Number(sum.rows[0].s)).toBe(1);
  });
});
