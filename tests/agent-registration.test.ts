import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { POST as registerPOST } from "../src/app/api/agent/register/route";
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
      `UPDATE agents SET pairing_code = $1, pairing_code_expires_at = now() + interval '30 minutes', secret = NULL, status = 'offline' WHERE id = $2`,
      [pairingCode, f.agentId],
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
      `SELECT pairing_code, secret, status, metadata FROM agents WHERE id = $1`,
      [f.agentId],
    )).rows[0];
    expect(row.pairing_code).toBeNull();
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
});
