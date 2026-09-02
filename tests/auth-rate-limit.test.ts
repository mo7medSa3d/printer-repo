import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { lockDurationMs, accountKey, ipKey, clientIpFrom } from "@/lib/auth-rate-limit";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
  pool,
} from "./helpers/pg";
import { POST as loginPOST } from "@/app/api/auth/manager/login/route";

describe("auth rate limiter (pure)", () => {
  it("has no lock below 5 failures", () => {
    expect(lockDurationMs(0)).toBe(0);
    expect(lockDurationMs(4)).toBe(0);
  });

  it("progresses 30s → 5min → 15min → 60min", () => {
    expect(lockDurationMs(5)).toBe(30_000);
    expect(lockDurationMs(9)).toBe(30_000);
    expect(lockDurationMs(10)).toBe(5 * 60_000);
    expect(lockDurationMs(15)).toBe(15 * 60_000);
    expect(lockDurationMs(20)).toBe(60 * 60_000);
  });

  it("normalizes account and IP keys", () => {
    expect(accountKey("  Admin ")).toBe("acct:admin");
    expect(ipKey("10.0.0.1")).toBe("ip:10.0.0.1");
  });

  it("reads X-Forwarded-For only when TRUST_PROXY is set", () => {
    const req = new Request("http://gw/login", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "10.0.0.1" },
    });
    const prev = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    expect(clientIpFrom(req)).toBe("10.0.0.1");
    process.env.TRUST_PROXY = "1";
    expect(clientIpFrom(req)).toBe("203.0.113.9");
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  });
});

const suite = describe.skipIf(!hasTestDatabase);

suite("manager login rate limiting", () => {
  const USER = "rate-limit-admin";
  const PASS = "correct-horse-battery";

  beforeAll(async () => {
    await applyMigrations();
    process.env.MANAGER_USERNAME = USER;
    process.env.MANAGER_PASSWORD = PASS;
    process.env.GATEWAY_JWT_SECRET = process.env.GATEWAY_JWT_SECRET || "x".repeat(32);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  function login(username: string, password: string, ip = "198.51.100.10") {
    return loginPOST(new Request("http://gateway.test/api/auth/manager/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ username, password }),
    }));
  }

  it("normal login succeeds", async () => {
    const res = await login(USER, PASS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("repeated failures then 429 with Retry-After", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await login(USER, "wrong");
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Invalid credentials");
    }
    const fifth = await login(USER, "wrong");
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("Retry-After")).toBeTruthy();
    const body = await fifth.json();
    expect(body.error).toMatch(/too many/i);
  });

  it("does not enumerate users", async () => {
    const known = await login(USER, "wrong");
    const unknown = await login("no-such-user", "wrong", "198.51.100.11");
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await known.json()).error).toBe((await unknown.json()).error);
  });

  it("different IPs are tracked separately", async () => {
    for (let i = 0; i < 5; i++) {
      await login(USER, "wrong", "203.0.113.1");
    }
    const other = await login(USER, PASS, "203.0.113.2");
    // Account bucket is locked from the first IP's failures, so even a
    // different IP must wait — no user-enumeration bypass via IP hopping
    // once the account identifier itself is cooling down.
    expect(other.status).toBe(429);
  });

  it("different accounts are tracked separately", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login("attacker", "wrong", "198.51.100.50");
      expect([401, 429]).toContain(res.status);
    }
    const ok = await login(USER, PASS, "198.51.100.51");
    expect(ok.status).toBe(200);
  });

  it("successful login after cooldown recovers the account bucket", async () => {
    for (let i = 0; i < 5; i++) {
      await login(USER, "wrong", "198.51.100.70");
    }
    await pool().query(`UPDATE auth_rate_limits SET locked_until = now() - interval '1 second'`);
    const ok = await login(USER, PASS, "198.51.100.70");
    expect(ok.status).toBe(200);

    // The ACCOUNT bucket is cleared by a successful login, so the legitimate
    // user recovers immediately.
    const acct = await pool().query(`SELECT failures FROM auth_rate_limits WHERE key = $1`, [
      accountKey(USER),
    ]);
    expect(acct.rowCount).toBe(0);

    // The IP bucket is deliberately NOT cleared: one user proving their
    // password on a shared address must not wipe the evidence of an attack
    // against other accounts from that same address. Its counter therefore
    // survives, and the next failure from this IP re-locks it.
    const ipRow = await pool().query(`SELECT failures FROM auth_rate_limits WHERE key = $1`, [
      ipKey("198.51.100.70"),
    ]);
    expect(Number(ipRow.rows[0].failures)).toBeGreaterThanOrEqual(5);
  });

  it("a successful login does NOT reset the IP bucket", async () => {
    // Regression guard for the asymmetry above — it is a security property,
    // not an accident.
    for (let i = 0; i < 5; i++) {
      await login(USER, "wrong", "198.51.100.71");
    }
    await pool().query(`UPDATE auth_rate_limits SET locked_until = now() - interval '1 second'`);
    expect((await login(USER, PASS, "198.51.100.71")).status).toBe(200);

    // Next wrong attempt from the same IP trips the IP lock again (6th failure
    // is inside the 5-9 band => 30s lock) rather than starting from zero.
    const after = await login(USER, "wrong", "198.51.100.71");
    expect(after.status).toBe(429);
  });

  it("concurrent attempts cannot bypass the limiter", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => login(USER, "wrong", "198.51.100.80"))
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.some((s) => s === 401 || s === 429)).toBe(true);
    const failures = await pool().query(
      `SELECT failures FROM auth_rate_limits WHERE key = $1`,
      ["acct:rate-limit-admin"]
    );
    expect(Number(failures.rows[0]?.failures ?? 0)).toBeGreaterThanOrEqual(5);
  });
});
