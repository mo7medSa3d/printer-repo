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
import { POST as heartbeatPOST } from "@/app/api/agent/heartbeat/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("heartbeat validation and lifecycle preservation", () => {
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

  it("leaves operator-disabled printers disabled", async () => {
    await pool().query(`UPDATE printers SET lifecycle = 'disabled' WHERE id = $1`, [f.printerId]);

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "Should not resurrect",
          connectionType: "spooler",
          protocol: "spooler",
          status: "online",
        }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(`SELECT lifecycle, status FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].lifecycle).toBe("disabled");
    expect(row.rows[0].status).toBe("online");
  });

  it("refuses to update a printer owned by another agent", async () => {
    const other = await seedFixture();
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: other.printerId,
          name: "Hijack",
          connectionType: "spooler",
          protocol: "spooler",
          status: "online",
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skippedPrinters).toContain(other.printerId);
    const row = await pool().query(`SELECT agent_id, name FROM printers WHERE id = $1`, [other.printerId]);
    expect(row.rows[0].agent_id).toBe(other.agentId);
    expect(row.rows[0].name).not.toBe("Hijack");
  });

  it("rejects an invalid agent status without mutating the existing agent", async () => {
    const before = await pool().query(`SELECT status, last_seen_at FROM agents WHERE id = $1`, [f.agentId]);

    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({ status: "definitely-not-valid", printers: [] }),
    }));
    expect(res.status).toBe(400);

    const after = await pool().query(`SELECT status, last_seen_at FROM agents WHERE id = $1`, [f.agentId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("normalizes agent and printer status casing/whitespace", async () => {
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: " ONLINE ",
        printers: [{
          id: f.printerId,
          name: "Normalized",
          printerType: "physical",
          deviceClass: "other",
          connectionType: "spooler",
          protocol: "spooler",
          status: " OFFLINE ",
        }],
      }),
    }));
    expect(res.status).toBe(200);

    const row = await pool().query(`SELECT status FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].status).toBe("offline");

    const agent = await pool().query(`SELECT status FROM agents WHERE id = $1`, [f.agentId]);
    expect(agent.rows[0].status).toBe("online");
  });
});
