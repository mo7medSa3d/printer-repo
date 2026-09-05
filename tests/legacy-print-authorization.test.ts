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
import { POST as printJobsPOST } from "@/app/api/print/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("legacy direct-printer print authorization", () => {
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

  function legacyCreate(body: unknown, key = f.odooKey) {
    return printJobsPOST(new Request("http://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("rejects a global/unscoped Odoo key for legacy direct printing", async () => {
    const globalKey = `odoo_global_${Date.now()}`;
    await pool().query(
      `INSERT INTO api_keys (id, branch_id, scope, name, hashed_key) VALUES ($1, NULL, 'standard', 'global legacy test', $2)`,
      [`key_global_${Date.now()}`, sha256(globalKey)],
    );

    const res = await legacyCreate({
      printerId: f.printerId,
      payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
    }, globalKey);

    expect(res.status).toBe(403);
  });

  it("rejects a branch key when the target printer belongs to another branch", async () => {
    const secondBranch = `branch_other_${Date.now()}`;
    const secondAgent = `agt_other_${Date.now()}`;
    const secondPrinter = `printer_other_${Date.now()}`;
    await pool().query(`INSERT INTO branches (id, name, enabled) VALUES ($1, 'Other Branch', true)`, [secondBranch]);
    await pool().query(`INSERT INTO agents (id, branch_id, name, secret, status, lifecycle, last_seen_at) VALUES ($1, $2, 'Other Agent', $3, 'online', 'active', now())`, [secondAgent, secondBranch, sha256("other-agent-secret")]);
    await pool().query(
      `INSERT INTO printers (id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config, capabilities)
       VALUES ($1, $2, 'Other Printer', 'physical', 'other', 'spooler', 'spooler', 'online', 'active', '{}'::jsonb, '{"supported_protocols":["raw"]}'::jsonb)`,
      [secondPrinter, secondAgent],
    );

    const res = await legacyCreate({
      printerId: secondPrinter,
      payload: { type: "raw", encoding: "base64", data: "aGVsbG8=" },
    });
    expect(res.status).toBe(403);
  });

  it("validates the legacy payload with the same canonical payload contract", async () => {
    const res = await legacyCreate({
      printerId: f.printerId,
      payload: { type: "pdf", encoding: "base64", data: Buffer.from("not a pdf").toString("base64") },
    });
    expect(res.status).toBe(400);
  });
});
