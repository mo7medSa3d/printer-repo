import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  jobRow,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { attachAgentWSS } from "@/server/ws";
import { POST as printJobsPOST, GET as printJobsGET } from "@/app/api/print/jobs/route";
import { PATCH as agentJobsPATCH } from "@/app/api/agent/jobs/route";

/**
 * Gateway end-to-end flow with a real database and a real agent WebSocket
 * client: Odoo creates the job → routing picks the printer → the gateway
 * claims it → it is delivered → the agent acks and reports progress →
 * Odoo reads the final status.
 *
 * This is the software path only. It does NOT prove that paper came out of a
 * physical printer.
 */

const suite = describe.skipIf(!hasTestDatabase);

function pdfBase64() {
  return Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
}

suite("end-to-end job flow (Odoo → gateway → agent socket → status)", () => {
  let server: Server;
  let port: number;
  let f: Fixture;
  const sockets: WebSocket[] = [];

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

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1, $2, $3, 'receipt', $4, 1, true)`,
      [`binding_${f.printerId}`, f.branchId, f.destinationId, f.printerId]
    );
  });

  async function connectAgent(fixture: Fixture) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`, { headers: { Authorization: fixture.agentAuth } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }

  function odooCreate(body: unknown) {
    return new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("delivers a PDF job to a connected agent as 'claimed' and completes it", async () => {
    const ws = await connectAgent(f);
    const received = new Promise<any>((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));

    const res = await printJobsPOST(odooCreate({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payload: { type: "pdf", encoding: "base64", data: pdfBase64() },
      idempotencyKey: "sale.order-42",
    }));
    expect(res.status).toBe(201);
    const created = await res.json();
    // The gateway claimed the job before delivering it, so the reported
    // status is the real row status.
    expect(created.status).toBe("claimed");
    expect(created.printerId).toBe(f.printerId);

    const envelope = await received;
    expect(envelope.type).toBe("print_job");
    expect(envelope.job.id).toBe(created.jobId);
    expect(envelope.job.status).toBe("claimed");
    expect(envelope.job.payload.type).toBe("pdf");

    ws.send(JSON.stringify({ type: "job_ack", jobId: created.jobId }));
    await expect.poll(async () => (await jobRow(created.jobId)).acked_at !== null, { timeout: 5000 }).toBe(true);

    const patch = (status: string) => agentJobsPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: created.jobId, status }),
    }));
    expect((await patch("printing")).status).toBe(200);
    expect((await patch("success")).status).toBe(200);

    const statusRes = await printJobsGET(new Request(
      `http://gateway.test/api/print/jobs?id=${created.jobId}&branchId=${f.branchId}`,
      { headers: { Authorization: `Bearer ${f.odooKey}` } }
    ));
    expect(statusRes.status).toBe(200);
    const finalStatus = await statusRes.json();
    expect(finalStatus.status).toBe("success");

    // The idempotent retry returns the SAME job id, never a second job.
    const retry = await printJobsPOST(odooCreate({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payload: { type: "pdf", encoding: "base64", data: pdfBase64() },
      idempotencyKey: "sale.order-42",
    }));
    expect(retry.status).toBe(200);
    expect((await retry.json()).jobId).toBe(created.jobId);
  });

  it("refuses a PDF for an ESC/POS-only printer with CAPABILITY_MISMATCH (422) and creates no job", async () => {
    const escpos = await seedFixture({ printerCapabilities: { supported_protocols: ["escpos", "raw"] } });
    await pool().query(
      `UPDATE printers SET connection_type='network', protocol='escpos' WHERE id = $1`,
      [escpos.printerId]
    );
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1, $2, $3, 'receipt', $4, 1, true)`,
      [`binding_${escpos.printerId}`, escpos.branchId, escpos.destinationId, escpos.printerId]
    );

    const res = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${escpos.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: escpos.branchId,
        destinationId: escpos.destinationId,
        documentType: "receipt",
        payload: { type: "pdf", encoding: "base64", data: pdfBase64() },
      }),
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("CAPABILITY_MISMATCH");

    const jobs = await pool().query(`SELECT count(*)::int AS n FROM print_jobs WHERE branch_id = $1`, [escpos.branchId]);
    expect(jobs.rows[0].n).toBe(0);

    // The same printer still accepts ESC/POS work.
    const ok = await printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${escpos.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        branchId: escpos.branchId,
        destinationId: escpos.destinationId,
        documentType: "receipt",
        payload: { type: "escpos", encoding: "base64", data: Buffer.from("\x1b@hello\x1dV\x01").toString("base64") },
      }),
    }));
    expect(ok.status).toBe(201);
  });

  it("keeps a job queued and recoverable when no agent socket is connected", async () => {
    const res = await printJobsPOST(odooCreate({
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "receipt",
      payload: { type: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") },
    }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe("queued");

    const row = await jobRow(created.jobId);
    expect(row.status).toBe("queued");
    expect(row.delivered_at).toBeNull();
    expect(row.delivery_attempts).toBe(0);
  });
});
