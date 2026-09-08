import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  type Fixture,
  sha256,
} from "./helpers/pg";
import { POST as printJobsPOST, GET as printJobsGET } from "../src/app/api/print/jobs/route";
import { createPrintJobForPrinter } from "../src/lib/print-job-service";

const suite = describe.skipIf(!hasTestDatabase);

function pdfBase64(suffix = "") {
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n${suffix}trailer<</Root 1 R>>\n%%EOF\n`).toString("base64");
}

suite("print idempotency (Odoo → Gateway)", () => {
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

  function create(body: unknown, key = f.odooKey) {
    return printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  function jobBody(idempotencyKey: string, extra: Record<string, unknown> = {}) {
    return {
      printerId: f.printerId,
      destination: "POS",
      documentType: "invoice",
      payload: { type: "pdf", encoding: "base64", data: pdfBase64() },
      idempotencyKey,
      ...extra,
    };
  }

  async function jobCount(): Promise<number> {
    const res = await pool().query(`SELECT count(*)::int AS n FROM print_jobs`);
    return res.rows[0].n;
  }

  it("first request creates one durable job", async () => {
    const res = await create(jobBody("op-first"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobId).toMatch(/^job_/);
    expect(await jobCount()).toBe(1);
  });

  it("retry returns the existing job", async () => {
    const first = await create(jobBody("op-retry"));
    expect(first.status).toBe(201);
    const created = await first.json();

    const retry = await create(jobBody("op-retry"));
    expect(retry.status).toBe(200);
    const again = await retry.json();
    expect(again.jobId).toBe(created.jobId);
    expect(await jobCount()).toBe(1);
  });

  it("same idempotency key with a different payload is rejected", async () => {
    const first = await create(jobBody("op-conflict"));
    expect(first.status).toBe(201);

    const conflicting = await create({
      ...jobBody("op-conflict"),
      payload: { type: "pdf", encoding: "base64", data: pdfBase64("different-document\n") },
    });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
    expect(await jobCount()).toBe(1);
  });

  it("same idempotency key with different routing inputs is rejected", async () => {
    const first = await create(jobBody("op-routing-conflict"));
    expect(first.status).toBe(201);

    const conflicting = await create(jobBody("op-routing-conflict", { destination: "Warehouse" }));
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
    expect(await jobCount()).toBe(1);
  });

  it("same idempotency key with a different printer is rejected", async () => {
    const secondPrinter = "printer_second";
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
       VALUES ($1, $2, $3, 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, $4::jsonb)`,
      [secondPrinter, f.agentId, "Second Printer", JSON.stringify({ supported_protocols: ["pdf"] })],
    );

    const first = await create(jobBody("op-printer-conflict"));
    expect(first.status).toBe(201);

    const conflicting = await create(jobBody("op-printer-conflict", { printerId: secondPrinter }));
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
    expect(await jobCount()).toBe(1);
  });

  it("concurrent retries create exactly one job", async () => {
    const key = "op-concurrent";
    const responses = await Promise.all([
      create(jobBody(key)),
      create(jobBody(key)),
      create(jobBody(key)),
      create(jobBody(key)),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const ids = new Set(bodies.map((b) => b.jobId));
    expect(ids.size).toBe(1);
    expect(await jobCount()).toBe(1);
    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
    }
  });

  it("rejects an explicit TTL longer than 24 hours", async () => {
    const res = await create(jobBody("op-ttl-too-long", {
      expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("24 hour maximum") });
    expect(await jobCount()).toBe(0);
  });

  it("accepts an explicit TTL within the 24-hour bound", async () => {
    const res = await create(jobBody("op-ttl-valid", {
      expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
    }));
    expect(res.status).toBe(201);
    expect(await jobCount()).toBe(1);
  });

  it("rejects legacy branch and destination identifiers at the new API boundary", async () => {
    const res = await create({
      ...jobBody("op-legacy-fields"),
      branchId: "legacy-branch",
      destinationId: "legacy-destination",
    });
    expect(res.status).toBe(400);
    expect(await jobCount()).toBe(0);
  });

  it("allows two intentional prints with different operation keys", async () => {
    const a = await create(jobBody("op-intent-1"));
    const b = await create(jobBody("op-intent-2"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = (await a.json()).jobId;
    const idB = (await b.json()).jobId;
    expect(idA).not.toBe(idB);
    expect(await jobCount()).toBe(2);
  });

  it("isolates job lookup and idempotency by Odoo installation key", async () => {
    const otherKey = "odoo_other_installation";
    await pool().query(
      `INSERT INTO api_keys (id, scope, name, hashed_key) VALUES ($1, 'standard', 'other installation', $2)`,
      ["key_other_installation", sha256(otherKey)],
    );

    const first = await create(jobBody("op-installation-scope"));
    expect(first.status).toBe(201);
    const created = await first.json();

    const foreignRead = await printJobsGET(new Request(`http://gateway.test/api/print/jobs?id=${created.jobId}`, {
      headers: { Authorization: `Bearer ${otherKey}` },
    }));
    expect(foreignRead.status).toBe(404);

    const sameOperationFromOtherInstallation = await create(jobBody("op-installation-scope"), otherKey);
    expect(sameOperationFromOtherInstallation.status).toBe(201);
    const second = await sameOperationFromOtherInstallation.json();
    expect(second.jobId).not.toBe(created.jobId);
    expect(await jobCount()).toBe(2);
  });

  it("internal requests (api_key_id is null) converge concurrently on one logical job", async () => {
    const key = "op-internal-concurrent";
    const payload = { type: "pdf", encoding: "base64", data: pdfBase64() };
    const opts = {
      requestedBy: "internal-service",
      idempotencyKey: key,
      destination: "POS",
      documentType: "invoice",
      rateLimitKeyId: null,
    };
    const results = await Promise.all([
      createPrintJobForPrinter(f.printerId, payload, opts),
      createPrintJobForPrinter(f.printerId, payload, opts),
      createPrintJobForPrinter(f.printerId, payload, opts),
    ]);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await jobCount()).toBe(1);
    const reusedCount = results.filter((r) => r.isReused).length;
    expect(reusedCount).toBe(2);
  });

  it("internal requests with same idempotency key targeting different printers/agents are rejected", async () => {
    const otherAgentId = "agent_other_internal";
    const otherPrinterId = "printer_other_internal";
    await pool().query(
      `INSERT INTO agents (id, name, status, lifecycle, metadata) VALUES ($1, 'Other Agent', 'online', 'active', '{"hostname":"host2","version":"1.0.0"}'::jsonb)`,
      [otherAgentId],
    );
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
       VALUES ($1, $2, 'Other Printer', 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, '{"supported_protocols":["pdf"]}'::jsonb)`,
      [otherPrinterId, otherAgentId],
    );

    const key = "op-internal-agent-conflict";
    const payload = { type: "pdf", encoding: "base64", data: pdfBase64() };
    const first = await createPrintJobForPrinter(f.printerId, payload, {
      requestedBy: "internal-service",
      idempotencyKey: key,
      destination: "POS",
      documentType: "invoice",
      rateLimitKeyId: null,
    });
    expect(first.id).toMatch(/^job_/);

    await expect(
      createPrintJobForPrinter(otherPrinterId, payload, {
        requestedBy: "internal-service",
        idempotencyKey: key,
        destination: "POS",
        documentType: "invoice",
        rateLimitKeyId: null,
      }),
    ).rejects.toThrow();
  });
});
