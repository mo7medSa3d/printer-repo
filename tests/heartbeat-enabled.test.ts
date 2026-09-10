import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  seedFixture,
  insertQueuedJob,
  jobRow,
  closePool,
  pool,
  type Fixture,
} from "./helpers/pg";
import { claimJobForDelivery } from "../src/lib/job-delivery";
import { POST as heartbeatPOST } from "../src/app/api/agent/heartbeat/route";

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
          config: { spooler_name: "NormalizedQueue" },
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

  it("bounds reported capabilities to the known vocabulary without failing the heartbeat", async () => {
    // Capability trust boundary: an authenticated agent may narrow its
    // device's routing surface but must not invent capabilities. Unknown
    // tokens are dropped per-row; the heartbeat for the device still lands.
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "CapsBounded",
          printerType: "physical",
          deviceClass: "thermal",
          connectionType: "network",
          protocol: "raw",
          config: { ip: "192.0.2.44", port: 9100 },
          status: "online",
          capabilities: { supported_protocols: ["raw", "LASER-9000", 42, "zpl"] },
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const row = await pool().query(`SELECT capabilities FROM printers WHERE id = $1`, [f.printerId]);
    expect(row.rows[0].capabilities.supported_protocols).toEqual(["raw", "zpl"]);
  });

  it("treats a non-array supported_protocols as absent instead of crashing the heartbeat", async () => {
    const res = await heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: f.agentAuth, "content-type": "application/json" },
      body: JSON.stringify({
        status: "online",
        printers: [{
          id: f.printerId,
          name: "CapsMalformed",
          printerType: "physical",
          deviceClass: "thermal",
          connectionType: "network",
          protocol: "escpos",
          config: { ip: "192.0.2.45", port: 9100 },
          status: "online",
          capabilities: { supported_protocols: "raw" },
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const row = await pool().query(`SELECT capabilities FROM printers WHERE id = $1`, [f.printerId]);
    const caps = row.rows[0].capabilities as Record<string, unknown>;
    expect("supported_protocols" in caps).toBe(false);
  });

  it("fences keep-alive lease refresh to the live claim (stale worker TOCTOU)", async () => {
    await insertQueuedJob(f, "job_hb_fence");
    const claim = await claimJobForDelivery("job_hb_fence", f.agentId);
    const liveToken = claim!.claimToken!;
    expect(liveToken).toBeTruthy();
    // Age the claim past the stale threshold so a refresh is observable.
    await pool().query(`UPDATE print_jobs SET updated_at = now() - interval '200 seconds' WHERE id = 'job_hb_fence'`);
    const staleAt = (await jobRow("job_hb_fence")).updated_at as Date;

    const beat = (auth: string, keepAliveJobIds: unknown) => heartbeatPOST(new Request("http://gateway.test/api/agent/heartbeat", {
      method: "POST",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ status: "online", printers: [], keepAliveJobIds }),
    }));

    // 1. A stale worker echoing a forged/superseded token refreshes nothing.
    expect((await beat(f.agentAuth, [{ jobId: "job_hb_fence", claimToken: "forged-token" }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    // 2. A legacy tokenless id refreshes nothing on a tokenized claim.
    expect((await beat(f.agentAuth, ["job_hb_fence"])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    // 3. Another agent's heartbeat (even with the right token) is scoped out.
    const other = await seedFixture();
    expect((await beat(other.agentAuth, [{ jobId: "job_hb_fence", claimToken: liveToken }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBe(new Date(staleAt).getTime());
    // 4. The live claim holder's pair refreshes the lease.
    expect((await beat(f.agentAuth, [{ jobId: "job_hb_fence", claimToken: liveToken }])).status).toBe(200);
    expect(new Date((await jobRow("job_hb_fence")).updated_at).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
  });
});
