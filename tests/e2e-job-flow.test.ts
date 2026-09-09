import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, jobRow, closePool, pool, type Fixture } from "./helpers/pg";
import { attachAgentWSS, handleAgentMessage } from "../src/server/ws";
import { POST as printJobsPOST, GET as printJobsGET } from "../src/app/api/print/jobs/route";
import { GET as agentJobsGET, PATCH as agentJobsPATCH } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);
function pdfBase64() { return Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64"); }
function odooRequest(key: string, body: unknown) { return new Request("http://gateway.test/api/print/jobs", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }

suite("end-to-end job flow (Odoo -> Gateway -> agent socket -> status)", () => {
  let server: Server; let port: number; let f: Fixture; const sockets: WebSocket[] = [];
  beforeAll(async () => {
    await applyMigrations();
    server = createServer((_req, res) => { res.writeHead(404).end(); });
    attachAgentWSS(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });

  async function connectAgent() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, { headers: { Authorization: f.agentAuth } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    return ws;
  }

  it("accepts a PDF job and delivers it to the connected agent", async () => {
    const ws = await connectAgent();
    const received = new Promise<any>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
    const payload = { printerId: f.printerId, destination: "POS", documentType: "receipt", payload: { type: "pdf", encoding: "base64", data: pdfBase64() }, idempotencyKey: "sale.order-42" };
    const res = await printJobsPOST(odooRequest(f.odooKey, payload));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.jobId).toMatch(/^job_/);
    expect(created.status).toBe("queued");
    expect(created.printerId).toBe(f.printerId);

    const envelope = await received;
    expect(envelope.type).toBe("print_job");
    expect(envelope.job.id).toBe(created.jobId);
    expect(envelope.job.status).toBe("claimed");
    expect(envelope.job.payload.type).toBe("pdf");

    ws.send(JSON.stringify({ type: "job_ack", jobId: created.jobId }));
    await expect.poll(async () => (await jobRow(created.jobId)).acked_at !== null, { timeout: 5000 }).toBe(true);
    // Execution fencing: every status report must carry the claim token the
    // gateway attached to THIS delivery attempt.
    expect(envelope.job.claimToken).toMatch(/.{8,}/);
    const patch = (status: string, token: string | null = envelope.job.claimToken) => agentJobsPATCH(new Request("http://gateway.test/api/agent/jobs", { method: "PATCH", headers: { Authorization: f.agentAuth, "content-type": "application/json" }, body: JSON.stringify({ jobId: created.jobId, status, ...(token ? { claimToken: token } : {}) }) }));
    expect((await patch("printing")).status).toBe(200);
    // A superseded/forged token can never finalize the job.
    expect((await patch("success", "stale-token-from-a-dead-attempt")).status).toBe(409);
    expect((await patch("success")).status).toBe(200);
    const statusRes = await printJobsGET(new Request(`http://gateway.test/api/print/jobs?id=${created.jobId}`, { headers: { Authorization: `Bearer ${f.odooKey}` } }));
    expect(statusRes.status).toBe(200);
    expect((await statusRes.json()).status).toBe("success");
    const retry = await printJobsPOST(odooRequest(f.odooKey, payload));
    expect(retry.status).toBe(200);
    expect((await retry.json()).jobId).toBe(created.jobId);
  });

  it("rejects a PDF for an ESC/POS-only printer", async () => {
    const escpos = await seedFixture({ printerCapabilities: { supported_protocols: ["escpos", "raw"] } });
    await pool().query(`UPDATE printers SET connection_type='network', protocol='escpos' WHERE id=$1`, [escpos.printerId]);
    const res = await printJobsPOST(odooRequest(escpos.odooKey, { printerId: escpos.printerId, documentType: "receipt", payload: { type: "pdf", encoding: "base64", data: pdfBase64() } }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("CAPABILITY_MISMATCH");
    const jobs = await pool().query(`SELECT count(*)::int AS n FROM print_jobs`);
    expect(jobs.rows[0].n).toBe(0);
    const ok = await printJobsPOST(odooRequest(escpos.odooKey, { printerId: escpos.printerId, documentType: "receipt", payload: { type: "escpos", protocol: "escpos", encoding: "base64", data: Buffer.from("\x1b@hello\x1dV\x01").toString("base64") } }));
    expect(ok.status).toBe(201);
  });

  it("keeps a job queued when no agent socket is connected", async () => {
    const res = await printJobsPOST(odooRequest(f.odooKey, { printerId: f.printerId, destination: "POS", documentType: "receipt", payload: { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") } }));
    expect(res.status).toBe(201);
    const created = await res.json();
    const row = await jobRow(created.jobId);
    expect(row.status).toBe("queued");
    expect(row.delivered_at).toBeNull();
  });

  it("supports polling claims and explicit job ACK", async () => {
    const createRes = await printJobsPOST(odooRequest(f.odooKey, { printerId: f.printerId, destination: "POS", documentType: "receipt", payload: { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") } }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const pollRes = await agentJobsGET(new Request("http://gateway.test/api/agent/jobs", { headers: { Authorization: f.agentAuth } }));
    expect(pollRes.status).toBe(200);
    const jobs = await pollRes.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(created.jobId);
    expect(jobs[0].status).toBe("claimed");
    expect(jobs[0].claimToken).toMatch(/.{8,}/);
    // The poll response itself IS the delivery: claimed rows are stamped
    // delivered_at so the stale-claim sweep can never silently re-deliver a
    // job the agent already holds (double-print protection).
    expect((await jobRow(created.jobId)).delivered_at).not.toBeNull();
    const pollPatch = (status: string, token?: string) => agentJobsPATCH(new Request("http://gateway.test/api/agent/jobs", { method: "PATCH", headers: { Authorization: f.agentAuth, "content-type": "application/json" }, body: JSON.stringify({ jobId: created.jobId, status, ...(token ? { claimToken: token } : {}) }) }));
    // Fenced: reporting without the claim token is rejected.
    expect((await pollPatch("printing")).status).toBe(409);
    expect((await pollPatch("printing", jobs[0].claimToken)).status).toBe(200);
    await handleAgentMessage(f.agentId, JSON.stringify({ type: "job_ack", jobId: created.jobId }));
    const row = await jobRow(created.jobId);
    expect(row.acked_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });
});
