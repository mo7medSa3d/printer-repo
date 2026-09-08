import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { validatePayloadForPrinter } from "../src/lib/routing";
import { POST as printJobsPOST, GET as printJobsGET } from "../src/app/api/print/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

function rawBase64(value = "hello") {
  return Buffer.from(value, "utf8").toString("base64");
}

suite("gateway runtime printer availability + payload capability contract", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  function create(body: unknown) {
    return printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${f.odooKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("accepts raw/escpos/pdf only when the printer capability boundary allows it", () => {
    expect(validatePayloadForPrinter("raw", {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw"] },
    })).toEqual({ ok: true });

    expect(validatePayloadForPrinter("pdf", {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw"] },
    }).ok).toBe(false);

    expect(validatePayloadForPrinter("pdf", {
      protocol: "spooler",
      connectionType: "spooler",
      capabilities: { supported_protocols: ["raw", "escpos", "pdf"] },
    })).toEqual({ ok: true });
  });

  it("creates a job for an active online physical printer using the new contract", async () => {
    const res = await create({
      printerId: f.printerId,
      destination: "POS",
      documentType: "receipt",
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: rawBase64() },
      idempotencyKey: "runtime-create-1",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ printerId: f.printerId, documentType: "receipt", destination: "POS" });
    expect(body.jobId).toMatch(/^job_/);
  });

  it("rejects an unknown printer with 404", async () => {
    const res = await create({
      printerId: "printer-does-not-exist",
      destination: "POS",
      documentType: "receipt",
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: rawBase64() },
    });
    expect(res.status).toBe(404);
  });

  it("rejects a disabled printer and does not persist a job", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
    const res = await create({
      printerId: f.printerId,
      destination: "POS",
      documentType: "receipt",
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: rawBase64() },
    });
    expect(res.status).toBe(503);
    expect((await pool().query(`SELECT count(*)::int AS n FROM print_jobs`)).rows[0].n).toBe(0);
  });

  it("rejects an offline printer and does not persist a job", async () => {
    await pool().query(`UPDATE printers SET status = 'offline' WHERE id = $1`, [f.printerId]);
    const res = await create({
      printerId: f.printerId,
      destination: "POS",
      documentType: "receipt",
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: rawBase64() },
    });
    expect(res.status).toBe(503);
    expect((await pool().query(`SELECT count(*)::int AS n FROM print_jobs`)).rows[0].n).toBe(0);
  });

  it("rejects an incompatible payload with 422", async () => {
    await pool().query(
      `UPDATE printers SET protocol = 'raw', connection_type = 'network', capabilities = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ supported_protocols: ["raw"] }), f.printerId],
    );
    const res = await create({
      printerId: f.printerId,
      destination: "POS",
      documentType: "invoice",
      payload: { type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4\nhello").toString("base64") },
    });
    expect(res.status).toBe(422);
    expect((await pool().query(`SELECT count(*)::int AS n FROM print_jobs`)).rows[0].n).toBe(0);
  });

  it("returns the persisted runtime status by job id", async () => {
    const created = await create({
      printerId: f.printerId,
      destination: "POS",
      documentType: "receipt",
      payload: { type: "raw", protocol: "raw", encoding: "base64", data: rawBase64() },
      idempotencyKey: "runtime-status-1",
    });
    expect(created.status).toBe(201);
    const jobId = (await created.json()).jobId;

    const status = await printJobsGET(new Request(`http://gateway.test/api/print/jobs?id=${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${f.odooKey}` },
    }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ jobId, printerId: f.printerId, status: "queued" });
  });

  it("requires a job id for status lookup", async () => {
    const res = await printJobsGET(new Request("http://gateway.test/api/print/jobs", {
      headers: { Authorization: `Bearer ${f.odooKey}` },
    }));
    expect(res.status).toBe(400);
  });
});
