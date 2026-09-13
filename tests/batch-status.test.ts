import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool, type Fixture } from "./helpers/pg";
import { POST as batchPOST } from "../src/app/api/print/jobs/batch-status/route";

const suite = describe.skipIf(!hasTestDatabase);
suite("POST /api/print/jobs/batch-status", () => {
  let f: Fixture;
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });
  afterAll(async () => { await closePool(); });

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  async function keyIdFor(rawKey: string): Promise<string> {
    const r = await pool().query(`SELECT id FROM api_keys WHERE hashed_key=$1`, [sha256(rawKey)]);
    if (r.rows.length !== 1) throw new Error("fixture api key missing");
    return r.rows[0].id as string;
  }
  async function insertJob(id: string, apiKeyId: string | null) {
    await pool().query(
      `INSERT INTO print_jobs (id, tenant_id, destination, document_type, agent_id, printer_id, api_key_id, status, payload, expires_at)
       VALUES ($1, $2, $3, 'receipt', $4, $5, $6, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour')`,
      [id, f.tenantId, f.destination, f.agentId, f.printerId, apiKeyId],
    );
  }
  const post = (key: string, body: unknown) => batchPOST(new Request("http://gateway.test/api/print/jobs/batch-status", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  it("returns only jobs owned by the calling api key", async () => {
    const keyId = await keyIdFor(f.odooKey);
    await insertJob("batch_owned_1", keyId);
    await insertJob("batch_owned_2", keyId);
    await insertJob("batch_foreign_1", null);
    const res = await post(f.odooKey, { jobIds: ["batch_owned_1", "batch_owned_2", "batch_foreign_1", "batch_missing_1"] });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { jobs: { jobId: string }[] }).jobs.map((j) => j.jobId).sort();
    expect(ids).toEqual(["batch_owned_1", "batch_owned_2"]);
  });

  it("rejects invalid keys and malformed bodies", async () => {
    expect((await post("odoo_wrongkey", { jobIds: ["x"] })).status).toBe(401);
    expect((await post(f.odooKey, { jobIds: [] })).status).toBe(400);
    expect((await post(f.odooKey, { jobIds: Array.from({ length: 101 }, (_, i) => `j${i}`) })).status).toBe(400);
    expect((await post(f.odooKey, { nope: true })).status).toBe(400);
  });
});
