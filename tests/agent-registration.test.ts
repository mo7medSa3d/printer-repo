import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as registerPOST } from "../src/app/api/agent/register/route";
import { hashPairingCode } from "../src/lib/agent-auth";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("agent registration contract", () => {
  const previousTrustProxy = process.env.TRUST_PROXY;

  beforeAll(async () => {
    await applyMigrations();
    process.env.TRUST_PROXY = "1";
  });

  afterAll(async () => {
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it("pairs using only the one-time pairing code and preserves runtime-only agent ownership", async () => {
    const f = await seedFixture();
    const pairingCode = "AB22CD";
    await pool().query(
      `UPDATE agents SET pairing_code_hash = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [hashPairingCode(pairingCode), f.agentId],
    );

    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.50" },
      body: JSON.stringify({ pairingCode: pairingCode.toLowerCase(), metadata: { hostname: "pos-01", os: "windows" } }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agentId).toBe(f.agentId);
    expect(body.secret).toMatch(/.+/);
    expect(body.branchId).toBeUndefined();

    const row = (await pool().query(
      `SELECT pairing_code_hash, secret, status, metadata FROM agents WHERE id = $1`,
      [f.agentId],
    )).rows[0];
    expect(row.pairing_code_hash).toBeNull();
    expect(row.secret).toBeTruthy();
    expect(row.secret).not.toBe(body.secret);
    expect(row.status).toBe("online");
    expect(row.metadata).toMatchObject({ hostname: "pos-01", os: "windows" });
  });

  it("rejects a client-supplied legacy branchId at the registration boundary", async () => {
    await seedFixture();
    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode: "AB22CD", branchId: "legacy-branch" }),
    }));

    expect(response.status).toBe(400);
  });

  it("rejects conflicting alias fields in registration payload", async () => {
    await seedFixture();
    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: "AB22CD",
        pairing_code: "EF33GH",
      }),
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Conflicting alias fields provided");

    const responseVersion = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: "AB22CD",
        clientVersion: "1.0.0",
        client_version: "2.0.0",
      }),
    }));

    expect(responseVersion.status).toBe(400);
    const bodyVersion = await responseVersion.json();
    expect(bodyVersion.error).toBe("Conflicting alias fields provided");

    const responseAgent = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: "AB22CD",
        agentId: "agent-1",
        agent_id: "agent-2",
      }),
    }));

    expect(responseAgent.status).toBe(400);
    const bodyAgent = await responseAgent.json();
    expect(bodyAgent.error).toBe("Conflicting alias fields provided");
  });

  it("accepts matching alias fields across pairingCode, agentId, and clientVersion", async () => {
    const f = await seedFixture();
    const pairingCode = "EF44GH";
    await pool().query(
      `UPDATE agents SET pairing_code_hash = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [hashPairingCode(pairingCode), f.agentId],
    );

    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.55" },
      body: JSON.stringify({
        pairingCode: pairingCode.toLowerCase(),
        pairing_code: pairingCode.toUpperCase(),
        agentId: f.agentId,
        agent_id: f.agentId,
        clientVersion: "3.0.0",
        client_version: "3.0.0",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agentId).toBe(f.agentId);
    expect(body.agent_id).toBe(f.agentId);
  });

  it("rejects invalid pairing attempts and rate-limits repeated failures", async () => {
    await seedFixture();
    const headers = { "content-type": "application/json", "x-real-ip": "127.0.0.60" };

    for (let i = 0; i < 5; i++) {
      const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
        method: "POST", headers, body: JSON.stringify({ pairingCode: "AAAAAA" }),
      }));
      expect(response.status).toBe(400);
    }

    const limited = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST", headers, body: JSON.stringify({ pairingCode: "BBBBBB" }),
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("supports unified registration payload with snake_case fields and returns agent_id and agent_secret", async () => {
    const f = await seedFixture();
    const pairingCode = "CD33EF";
    await pool().query(
      `UPDATE agents SET pairing_code_hash = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [hashPairingCode(pairingCode), f.agentId],
    );

    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "127.0.0.70" },
      body: JSON.stringify({
        pairing_code: pairingCode.toLowerCase(),
        hostname: "pos-lane-02",
        client_version: "2.1.0",
        platform: "windows",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agent_id).toBe(f.agentId);
    expect(body.agentId).toBe(f.agentId);
    expect(body.agent_secret).toMatch(/.+/);
    expect(body.secret).toBe(body.agent_secret);

    const row = (await pool().query(
      `SELECT pairing_code_hash, secret, status, metadata FROM agents WHERE id = $1`,
      [f.agentId],
    )).rows[0];
    expect(row.pairing_code_hash).toBeNull();
    expect(row.secret).toBeTruthy();
    expect(row.status).toBe("online");
    expect(row.metadata).toMatchObject({ hostname: "pos-lane-02", version: "2.1.0", os: "windows" });
  });

  it("handles concurrent registration on the same pairing code with exactly one winner", async () => {
    const f = await seedFixture();
    const pairingCode = "CC44DD";
    await pool().query(
      `UPDATE agents SET pairing_code_hash = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [hashPairingCode(pairingCode), f.agentId],
    );

    const makeReq = (ip: string) =>
      registerPOST(
        new Request("http://gateway.test/api/agent/register", {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": ip },
          body: JSON.stringify({ pairing_code: pairingCode }),
        }),
      );

    const [res1, res2] = await Promise.all([makeReq("127.0.0.81"), makeReq("127.0.0.82")]);
    const statuses = [res1.status, res2.status].sort();

    // Exactly one must succeed (200), and the losing concurrent request receives either 409 (if reached update) or 400 (if read after winner's commit)
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    const winnerRes = res1.status === 200 ? res1 : res2;
    const winnerBody = await winnerRes.json();
    expect(winnerBody.agent_id).toBe(f.agentId);
    expect(winnerBody.agent_secret).toBeTruthy();
  });
});


