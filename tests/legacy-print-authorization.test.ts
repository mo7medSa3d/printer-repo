import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  closePool,
  pool,
  sha256,
  type Fixture,
} from "./helpers/pg";
import { POST as printJobsPOST } from "../src/app/api/print/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("installation API-key print authorization", () => {
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

  it("accepts a valid installation-level Odoo key for an online printer", async () => {
    const res = await create({
      printerId: f.printerId,
      documentType: "receipt",
      destination: "POS",
      payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
      idempotencyKey: "installation-key-1",
    });
    expect(res.status).toBe(201);
  });

  it("rejects an invalid or revoked installation key", async () => {
    const keyId = `key_revoked_${Date.now()}`;
    const rawKey = `odoo_revoked_${Date.now()}`;
    await pool().query(
      `INSERT INTO api_keys (id, scope, name, hashed_key) VALUES ($1, 'odoo', 'revoked', $2)`,
      [keyId, sha256(rawKey)],
    );
    await pool().query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [keyId]);

    const res = await create({
      printerId: f.printerId,
      documentType: "receipt",
      destination: "POS",
      payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
    }, rawKey);
    expect(res.status).toBe(401);
  });

  it("rejects legacy branch/document authorization fields at the API boundary", async () => {
    const res = await create({
      printerId: f.printerId,
      documentType: "receipt",
      destination: "POS",
      payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
      branchId: "legacy-branch-id",
      allowedDocumentTypes: ["receipt"],
    });
    expect(res.status).toBe(400);
  });
});
