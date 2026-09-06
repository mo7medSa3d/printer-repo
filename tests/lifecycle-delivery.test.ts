import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  jobRow,
  pool,
  closePool,
  type Fixture,
} from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

type Lifecycle = "active" | "disabled" | "retired";

suite("delivery lifecycle enforcement", () => {
  let f: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  afterAll(async () => {
    await closePool();
  });

  async function setLifecycle(kind: "agent" | "printer", lifecycle: Lifecycle) {
    const column = kind === "agent" ? "agents" : "printers";
    const id = kind === "agent" ? f.agentId : f.printerId;
    await pool().query(`UPDATE ${column} SET lifecycle = $1 WHERE id = $2`, [lifecycle, id]);
  }

  it.each(["disabled", "retired"] as Lifecycle[])('does not claim a queued job for a %s printer', async (lifecycle) => {
    await insertQueuedJob(f, `printer_${lifecycle}`);
    await setLifecycle("printer", lifecycle);

    expect(await claimJobForDelivery(`printer_${lifecycle}`, f.agentId)).toBeNull();
    expect((await jobRow(`printer_${lifecycle}`)).status).toBe("queued");
  });

  it.each(["disabled", "retired"] as Lifecycle[])('does not claim a queued job for a %s agent', async (lifecycle) => {
    await insertQueuedJob(f, `agent_${lifecycle}`);
    await setLifecycle("agent", lifecycle);

    expect(await claimJobForDelivery(`agent_${lifecycle}`, f.agentId)).toBeNull();
    expect((await jobRow(`agent_${lifecycle}`)).status).toBe("queued");
  });

  it("does not claim a queued job when its branch is disabled", async () => {
    await insertQueuedJob(f, "branch_disabled");
    await pool().query(`UPDATE branches SET enabled = false WHERE id = $1`, [f.branchId]);

    expect(await claimJobForDelivery("branch_disabled", f.agentId)).toBeNull();
    expect((await jobRow("branch_disabled")).status).toBe("queued");
  });

  it("linearizes a lifecycle update and a claim on the same owner rows", async () => {
    await insertQueuedJob(f, "race_lifecycle");
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM printers WHERE id = $1 FOR UPDATE`, [f.printerId]);

      const claiming = claimJobForDelivery("race_lifecycle", f.agentId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);
      await client.query("COMMIT");

      expect(await claiming).toBeNull();
      expect((await jobRow("race_lifecycle")).status).toBe("queued");
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
  });
});
