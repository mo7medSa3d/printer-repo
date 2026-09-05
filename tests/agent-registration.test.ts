import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as registerPOST } from "../src/app/api/agent/register/route";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, closePool, pool } from "./helpers/pg";

const suite = describe.skipIf(!hasTestDatabase);

suite("agent registration contract", () => {
  const previousTrustProxy = process.env.TRUST_PROXY;

  beforeAll(async () => {
    await applyMigrations();
    // These integration tests intentionally exercise the IP-scoped limiter via
    // x-real-ip, so they must run with an explicitly trusted test proxy.
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

  it("pairs using only the one-time pairing code and derives branch from the pre-provisioned agent", async () => {
    const f = await seedFixture();
    const pairingCode = "123423";
    await pool().query(
      `UPDATE agents SET pairing_code = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [pairingCode, f.agentId],
    );

    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "127.0.0.50",
      },
      body: JSON.stringify({
        pairingCode,
        metadata: { hostname: "pos-01", os: "windows" },
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agentId).toBe(f.agentId);
    expect(body.branchId).toBe(f.branchId);
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(20);

    const row = (await pool().query(
      `SELECT branch_id, pairing_code, secret, status FROM agents WHERE id = $1`,
      [f.agentId],
    )).rows[0];
    expect(row.branch_id).toBe(f.branchId);
    expect(row.pairing_code).toBeNull();
    expect(row.secret).toBeTruthy();
    expect(row.secret).not.toBe(body.secret);
    expect(row.status).toBe("online");
  });

  it("rejects a client-supplied branchId before any ownership lookup", async () => {
    const f = await seedFixture();
    const pairingCode = "123423";
    await pool().query(
      `UPDATE agents SET pairing_code = $1, pairing_code_expires_at = now() + interval '30 minutes' WHERE id = $2`,
      [pairingCode, f.agentId],
    );

    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingCode, branchId: "attacker-branch" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "branchId is not accepted during registration" });
  });

  it("rejects branchId deterministically even when pairingCode is missing", async () => {
    const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branchId: "attacker-branch" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "branchId is not accepted during registration" });
  });

  it("invalid pairing attempts are rate-limited", async () => {
    await seedFixture();
    const headers = {
      "content-type": "application/json",
      "x-real-ip": "127.0.0.60",
    };

    for (let i = 0; i < 5; i++) {
      const response = await registerPOST(new Request("http://gateway.test/api/agent/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ pairingCode: `99999${i}` }),
      }));
      expect(response.status).toBe(400);
    }

    const limited = await registerPOST(new Request("http://gateway.test/api/agent/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ pairingCode: "999999" }),
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
