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
import { sweepPrintJobs, MAX_RETRIES } from "../src/lib/job-maintenance";
import { GET as agentJobsGET } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("server-side print job maintenance", () => {
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

  async function insertJob(id: string, status: string, retries = 0, ageSeconds = 120, expiresOffsetSeconds = 3600) {
    await pool().query(
      `INSERT INTO print_jobs (id, branch_id, destination_id, agent_id, printer_id, status, payload, retries, claimed_at, delivered_at, acked_at, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, now() - make_interval(secs => $8), NULL, NULL, now() + make_interval(secs => $9), now() - make_interval(secs => $8), now() - make_interval(secs => $8))`,
      [id, f.branchId, f.destinationId, f.agentId, f.printerId, status, retries, ageSeconds, expiresOffsetSeconds],
    );
  }

  it("expires overdue non-terminal jobs", async () => {
    await insertJob("job-expired-maintenance", "queued", 0, 120, -60);
    const result = await sweepPrintJobs();
    expect(result.expired).toBe(1);
    const row = await pool().query(`SELECT status FROM print_jobs WHERE id = $1`, ["job-expired-maintenance"]);
    expect(row.rows[0].status).toBe("expired");
  });

  it("requeues stale claims and the Agent can claim the recovered job", async () => {
    await insertJob("job-stale-claim", "claimed", 2, 120, 3600);
    const result = await sweepPrintJobs({ agentId: f.agentId, branchId: f.branchId });
    expect(result.requeuedClaims).toBe(1);

    const row = await pool().query(`SELECT status, retries, claimed_at, delivered_at, acked_at FROM print_jobs WHERE id = $1`, ["job-stale-claim"]);
    expect(row.rows[0]).toMatchObject({ status: "queued", retries: 3, claimed_at: null, delivered_at: null, acked_at: null });

    const response = await agentJobsGET(new Request("http://gateway.test/api/agent/jobs", {
      method: "GET",
      headers: { Authorization: f.agentAuth },
    }));
    expect(response.status).toBe(200);
    const claimed = await response.json();
    expect(claimed.some((job: { id: string; status: string }) => job.id === "job-stale-claim" && job.status === "claimed")).toBe(true);
  });

  it("fails a stale claim after the retry budget is exhausted", async () => {
    await insertJob("job-exhausted-claim", "claimed", MAX_RETRIES, 120, 3600);
    const result = await sweepPrintJobs();
    expect(result.exhaustedClaims).toBe(1);
    const row = await pool().query(`SELECT status, error FROM print_jobs WHERE id = $1`, ["job-exhausted-claim"]);
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].error).toContain("max retries");
  });

  it("fails stale printing leases without requeueing physical execution", async () => {
    await insertJob("job-stale-printing", "printing", 0, 11 * 60, 3600);
    const result = await sweepPrintJobs();
    expect(result.stalePrinting).toBe(1);
    const row = await pool().query(`SELECT status, error FROM print_jobs WHERE id = $1`, ["job-stale-printing"]);
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].error).toContain("AGENT_EXECUTION_TIMEOUT");
  });
});
