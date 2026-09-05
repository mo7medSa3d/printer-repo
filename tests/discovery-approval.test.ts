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
import { createManagerSession } from "@/lib/manager-auth";
import { POST as discoveryReportPOST } from "@/app/api/agent/discovery/route";
import { POST as verifyPOST } from "@/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route";
import { POST as provisionPOST } from "@/app/api/agents/[id]/discovered-printers/[deviceId]/provision/route";

const suite = describe.skipIf(!hasTestDatabase);

suite("discovery trust and approval flow", () => {
  let f: Fixture;

  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
    delete process.env.GATEWAY_JWT_SECRET;
  });

  beforeEach(async () => {
    await truncateAll();
    f = await seedFixture();
  });

  async function createDiscoverySession(id = `disc_${Date.now()}`) {
    await pool().query(
      `INSERT INTO discovery_sessions (id, agent_id, branch_id, status, config, stats)
       VALUES ($1, $2, $3, 'running', '{}'::jsonb, '{}'::jsonb)`,
      [id, f.agentId, f.branchId],
    );
    return id;
  }

  function agentRequest(discoveryId: string, devices: unknown[]) {
    return discoveryReportPOST(new Request("http://gateway.test/api/agent/discovery", {
      method: "POST",
      headers: {
        Authorization: f.agentAuth,
        "content-type": "application/json",
      },
      body: JSON.stringify({ discoveryId, status: "completed", devices }),
    }));
  }

  async function managerRequest(token: string, path: string) {
    return new Request(`http://gateway.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("treats agent verification/confidence as untrusted observation data", async () => {
    const discoveryId = await createDiscoverySession();
    const res = await agentRequest(discoveryId, [{
      id: "device-trust-1",
      source: ["ipp"],
      protocol: "ipp",
      ipAddress: "192.168.10.44",
      port: 631,
      verification: "verified",
      confidence: "high",
      capabilities: { supported_protocols: ["pdf"] },
    }]);

    expect(res.status).toBe(200);
    const row = await pool().query(
      `SELECT verification, confidence, candidate_status FROM discovered_devices WHERE id = $1`,
      ["device-trust-1"],
    );
    expect(row.rows[0]).toEqual({
      verification: "candidate",
      confidence: "low",
      candidate_status: "discovered",
    });
  });

  it("rejects public IPv6 discovery reports at the Gateway boundary", async () => {
    const discoveryId = await createDiscoverySession();
    const res = await agentRequest(discoveryId, [{
      id: "device-public-v6",
      protocol: "ipp",
      ipAddress: "2001:4860:4860::8888",
      port: 631,
    }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("private or link-local");
  });

  it("requires explicit manager approval before provisioning", async () => {
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-provision-1",
      source: ["ipp"],
      protocol: "ipp",
      ipAddress: "192.168.10.50",
      port: 631,
      uri: "ipp://192.168.10.50/ipp/print",
      deviceName: "Approved Printer",
    }]);

    const manager = await createManagerSession();
    const unapproved = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-provision-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(unapproved.status).toBe(409);
    expect((await unapproved.json()).code).toBe("DEVICE_NOT_APPROVED");

    const verify = await verifyPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-provision-1/verify`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const provision = await provisionPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-provision-1/provision`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-provision-1" }) } as any,
    );
    expect(provision.status).toBe(201);

    const body = await provision.json();
    const printer = await pool().query(`SELECT agent_id, lifecycle, status, protocol FROM printers WHERE id = $1`, [body.printerId]);
    expect(printer.rows[0]).toEqual({ agent_id: f.agentId, lifecycle: "active", status: "unknown", protocol: "ipp" });

    const device = await pool().query(`SELECT verification, confidence, candidate_status, provisioned_printer_id FROM discovered_devices WHERE id = $1`, ["device-provision-1"]);
    expect(device.rows[0].verification).toBe("verified");
    expect(device.rows[0].confidence).toBe("low");
    expect(device.rows[0].candidate_status).toBe("provisioned");
    expect(device.rows[0].provisioned_printer_id).toBe(body.printerId);
  });

  it("serializes concurrent provisioning so one candidate cannot create two printers", async () => {
    const discoveryId = await createDiscoverySession();
    await agentRequest(discoveryId, [{
      id: "device-concurrent-1",
      source: ["ipp"],
      protocol: "ipp",
      ipAddress: "192.168.10.51",
      port: 631,
      uri: "ipp://192.168.10.51/ipp/print",
      deviceName: "Concurrent Printer",
    }]);

    const manager = await createManagerSession();
    const verify = await verifyPOST(
      await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-concurrent-1/verify`),
      { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
    );
    expect(verify.status).toBe(200);

    const [a, b] = await Promise.all([
      provisionPOST(
        await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-concurrent-1/provision`),
        { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
      ),
      provisionPOST(
        await managerRequest(manager.token, `/api/agents/${f.agentId}/discovered-printers/device-concurrent-1/provision`),
        { params: Promise.resolve({ id: f.agentId, deviceId: "device-concurrent-1" }) } as any,
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const count = await pool().query(
      `SELECT count(*)::int AS count FROM printers WHERE agent_id = $1 AND config->>'ip' = $2 AND (config->>'port')::int = $3`,
      [f.agentId, "192.168.10.51", 631],
    );
    expect(count.rows[0].count).toBe(1);
  });
});
