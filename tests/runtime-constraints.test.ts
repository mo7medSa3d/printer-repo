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
    await expectRejected(`INSERT INTO print_jobs (id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, 'invoice', $3, $4, 'bogus', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour')`,
      [id, f.destination, f.agentId, f.printerId]);

    const validId = `job_constraint_${Date.now()}_2`;
    await pool().query(`INSERT INTO print_jobs (id, destination, document_type, agent_id, printer_id, status, payload, expires_at)
      VALUES ($1, $2, 'invoice', $3, $4, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour')`,
      [validId, f.destination, f.agentId, f.printerId]);
    await expectRejected(`UPDATE print_jobs SET retries = -1 WHERE id = $1`, [validId]);
    await expectRejected(`UPDATE print_jobs SET delivery_attempts = -1 WHERE id = $1`, [validId]);
  });

  it("enforces installation-scoped print-job idempotency uniqueness", async () => {
    const key = `idempotent_${Date.now()}`;
    const apiKeyId = `key_${Date.now()}`;
    await pool().query(`INSERT INTO api_keys (id, scope, name, hashed_key)
      VALUES ($1, 'standard', 'constraint key', $2)`, [apiKeyId, apiKeyId]);

    await pool().query(`INSERT INTO print_jobs (id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, 'invoice', $4, $5, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $6)`,
      [`job_constraint_${Date.now()}_3`, apiKeyId, f.destination, f.agentId, f.printerId, key]);

    await expect(pool().query(`INSERT INTO print_jobs (id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, 'invoice', $4, $5, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $6)`,
      [`job_constraint_${Date.now()}_4`, apiKeyId, f.destination, f.agentId, f.printerId, key])).rejects.toMatchObject({ code: "23505" });

    const otherApiKeyId = `key_other_${Date.now()}`;
    await pool().query(`INSERT INTO api_keys (id, scope, name, hashed_key)
      VALUES ($1, 'standard', 'other constraint key', $2)`, [otherApiKeyId, otherApiKeyId]);
    await expect(pool().query(`INSERT INTO print_jobs (id, api_key_id, destination, document_type, agent_id, printer_id, status, payload, expires_at, idempotency_key)
      VALUES ($1, $2, $3, 'invoice', $4, $5, 'queued', '{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now() + interval '1 hour', $6)`,
      [`job_constraint_${Date.now()}_5`, otherApiKeyId, f.destination, f.agentId, f.printerId, key])).resolves.toMatchObject({ rowCount: 1 });
  });
});
