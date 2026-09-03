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

const suite = describe.skipIf(!hasTestDatabase);

suite("database runtime state constraints", () => {
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

  async function expectRejected(sqlText: string, values: unknown[]) {
    await expect(pool().query(sqlText, values)).rejects.toMatchObject({ code: "23514" });
  }

  it("rejects invalid agent status", async () => {
    await expectRejected(`UPDATE agents SET status = 'bogus' WHERE id = $1`, [f.agentId]);
  });

  it("rejects invalid printer status", async () => {
    await expectRejected(`UPDATE printers SET status = 'bogus' WHERE id = $1`, [f.printerId]);
  });

  it("rejects invalid print job status and negative counters", async () => {
    const id = `job_constraint_${Date.now()}_1`;
    await expectRejected(`INSERT INTO print_jobs (id, branch_id, destination_id, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'bogus', '{}'::jsonb, now() + interval '1 hour')`, [id, f.branchId, f.destinationId, f.agentId, f.printerId]);

    const validId = `job_constraint_${Date.now()}_2`;
    await pool().query(`INSERT INTO print_jobs (id, branch_id, destination_id, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'queued', '{}'::jsonb, now() + interval '1 hour')`, [validId, f.branchId, f.destinationId, f.agentId, f.printerId]);
    await expectRejected(`UPDATE print_jobs SET retries = -1 WHERE id = $1`, [validId]);
    await expectRejected(`UPDATE print_jobs SET delivery_attempts = -1 WHERE id = $1`, [validId]);
  });

  it("rejects negative printer-binding priority", async () => {
    await expectRejected(`INSERT INTO printer_bindings (id, branch_id, destination_id, printer_id, priority)
      VALUES ($1, $2, $3, $4, -1)`, [`binding_constraint_${Date.now()}`, f.branchId, f.destinationId, f.printerId]);
  });
});
