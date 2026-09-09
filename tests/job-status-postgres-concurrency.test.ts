import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, insertQueuedJob, pool, closePool, type Fixture } from "./helpers/pg";
import { PATCH as jobStatusPATCH } from "../src/app/api/agent/jobs/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("atomic Agent job status transitions", () => {
  let f: Fixture;
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); f = await seedFixture(); });

  it("allows at most one of two concurrent printing->terminal transitions", async () => {
    await insertQueuedJob(f, "job_race");
    await pool().query(`UPDATE print_jobs SET status='printing' WHERE id='job_race'`);
    const p1 = pool().connect(); const p2 = pool().connect();
    const [a,b] = await Promise.all([p1,p2]);
    try {
      const expected = "printing";
      const [ra,rb] = await Promise.all([
        a.query(`UPDATE print_jobs SET status='success', updated_at=now() WHERE id=$1 AND agent_id=$2 AND status=$3 RETURNING status`, ["job_race", f.agentId, expected]),
        b.query(`UPDATE print_jobs SET status='failed', updated_at=now() WHERE id=$1 AND agent_id=$2 AND status=$3 RETURNING status`, ["job_race", f.agentId, expected]),
      ]);
      expect((ra.rowCount ?? 0) + (rb.rowCount ?? 0)).toBe(1);
      const row = await pool().query(`SELECT status FROM print_jobs WHERE id='job_race'`);
      expect(["success", "failed"]).toContain(row.rows[0].status);
    } finally { a.release(); b.release(); }
  });

  it("rejects a concurrent transition from a terminal winner", async () => {
    await insertQueuedJob(f, "job_terminal");
    await pool().query(`UPDATE print_jobs SET status='success' WHERE id='job_terminal'`);
    const res = await pool().query(`UPDATE print_jobs SET status='failed' WHERE id=$1 AND agent_id=$2 AND status='printing' RETURNING status`, ["job_terminal", f.agentId]);
    expect(res.rowCount).toBe(0);
  });
  it("rejects one conflicting transition when two HTTP PATCH requests race", async () => {
    await insertQueuedJob(f, "job_api_race");
    await pool().query(`UPDATE print_jobs SET status='printing' WHERE id='job_api_race'`);
    const request = (status: "success" | "failed") => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job_api_race", status }),
    }));
    const [a, b] = await Promise.all([request("success"), request("failed")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await pool().query(`SELECT status FROM print_jobs WHERE id='job_api_race'`);
    expect(["success", "failed"]).toContain(row.rows[0].status);
  });

  it("late success through the route requires the unknown-wait marker AND a fresh failure", async () => {
    const patch = (jobId: string, status: string, claimToken?: string) => jobStatusPATCH(new Request("http://gateway.test/api/agent/jobs", {
      method: "PATCH",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ jobId, status, ...(claimToken ? { claimToken } : {}) }),
    }));
    // 1. Plain failures can never become successes.
    await insertQueuedJob(f, "job_late_plain");
    await pool().query(`UPDATE print_jobs SET status='failed', error='CONNECTION_ERROR: refused', updated_at=now() WHERE id='job_late_plain'`);
    expect((await patch("job_late_plain", "success")).status).toBe(409);
    // 2. A gateway-timeout failure WITHIN 24h may be overridden by the true
    // physical outcome the agent reports.
    await insertQueuedJob(f, "job_late_ok");
    await pool().query(`UPDATE print_jobs SET status='failed', error='AGENT_EXECUTION_TIMEOUT: agent execution lease expired (physical output is unknown; manual reconciliation required)', updated_at=now() WHERE id='job_late_ok'`);
    const ok = await patch("job_late_ok", "success");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { physicalOutcome?: string }).physicalOutcome).toBe("printed");
    // 3. The same marker past the 24h TTL is no longer overridable.
    await insertQueuedJob(f, "job_late_stale");
    await pool().query(`UPDATE print_jobs SET status='failed', error='AGENT_RESTART_DURING_PRINT: crashed', updated_at=now() - interval '25 hours' WHERE id='job_late_stale'`);
    expect((await patch("job_late_stale", "success")).status).toBe(409);
  });

});
