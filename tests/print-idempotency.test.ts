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
import { POST as printJobsPOST } from "@/app/api/print/jobs/route";

/**
 * P0 — print idempotency.
 *
 * A retry of ONE logical print operation (same operation / idempotency key)
 * must collapse to a single Gateway job. Two intentional print actions
 * (two keys) must create two jobs. Identity is the caller-supplied
 * operation id, never (model + record_ids + report_id + current_minute).
 */

const suite = describe.skipIf(!hasTestDatabase);

function pdfBase64() {
  return Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
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
    await pool().query(
      `INSERT INTO printer_bindings (id, branch_id, destination_id, document_type, printer_id, priority, enabled)
       VALUES ($1, $2, $3, 'invoice', $4, 1, true)`,
      [`binding_${f.printerId}`, f.branchId, f.destinationId, f.printerId]
    );
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
      branchId: f.branchId,
      destinationId: f.destinationId,
      documentType: "invoice",
      payload: { type: "pdf", encoding: "base64", data: pdfBase64() },
      idempotencyKey,
      ...extra,
    };
  }

  async function jobCount(branchId?: string): Promise<number> {
    const res = branchId
      ? await pool().query(`SELECT count(*)::int AS n FROM print_jobs WHERE branch_id = $1`, [branchId])
      : await pool().query(`SELECT count(*)::int AS n FROM print_jobs`);
    return res.rows[0].n;
  }

  it("first request creates one job", async () => {
    const res = await create(jobBody("op-first"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobId).toMatch(/^job_/);
    expect(await jobCount(f.branchId)).toBe(1);
  });

  it("retry returns the existing job", async () => {
    const first = await create(jobBody("op-retry"));
    expect(first.status).toBe(201);
    const created = await first.json();

    const retry = await create(jobBody("op-retry"));
    expect(retry.status).toBe(200);
    const again = await retry.json();
    expect(again.jobId).toBe(created.jobId);
    expect(await jobCount(f.branchId)).toBe(1);
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
    expect(await jobCount(f.branchId)).toBe(1);
    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
    }
  });

  it("timeout after Gateway acceptance + retry does not duplicate", async () => {
    // Simulate: the first POST was accepted (row exists) and the caller never
    // saw the 201. The retry uses the same operation id.
    const first = await create(jobBody("op-timeout"));
    expect(first.status).toBe(201);
    const created = await first.json();

    const retry = await create(jobBody("op-timeout"));
    expect(retry.status).toBe(200);
    expect((await retry.json()).jobId).toBe(created.jobId);
    expect(await jobCount(f.branchId)).toBe(1);
  });

  it("two intentional prints create two jobs", async () => {
    const a = await create(jobBody("op-intent-1"));
    const b = await create(jobBody("op-intent-2"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = (await a.json()).jobId;
    const idB = (await b.json()).jobId;
    expect(idA).not.toBe(idB);
    expect(await jobCount(f.branchId)).toBe(2);
  });

  it("different reports do not collide", async () => {
    const a = await create(jobBody("op-report-invoice"));
    const b = await create(jobBody("op-report-receipt"));
    expect((await a.json()).jobId).not.toBe((await b.json()).jobId);
    expect(await jobCount(f.branchId)).toBe(2);
  });

  it("different records do not collide", async () => {
    const a = await create(jobBody("op-record-101"));
    const b = await create(jobBody("op-record-202"));
    expect((await a.json()).jobId).not.toBe((await b.json()).jobId);
    expect(await jobCount(f.branchId)).toBe(2);
  });

  it("same record intentionally printed twice does not collide", async () => {
    const a = await create(jobBody("op-sale-order-42-click-1"));
    const b = await create(jobBody("op-sale-order-42-click-2"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await a.json()).jobId).not.toBe((await b.json()).jobId);
    expect(await jobCount(f.branchId)).toBe(2);
  });
});
