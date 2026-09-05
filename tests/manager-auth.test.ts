import { createHmac, scryptSync } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import {
  hasTestDatabase,
  applyMigrations,
  truncateAll,
  closePool,
} from "./helpers/pg";
import {
  createManagerSession,
  verifyManagerToken,
  verifyManagerPassword,
  validateManagerClaims,
} from "../src/lib/manager-auth";

const suite = describe.skipIf(!hasTestDatabase);

suite("manager authentication hardening", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
    delete process.env.MANAGER_PASSWORD_HASH;
    delete process.env.MANAGER_PASSWORD;
  });

  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a session that verifies and is backed by a DB session", async () => {
    const created = await createManagerSession();
    const claims = verifyManagerToken(created.token);
    expect(claims).not.toBeNull();
    expect(claims?.jti).toBe(created.jti);
    expect(claims?.sub).toBe("manager");
    await expect(validateManagerClaims(claims)).resolves.not.toBeNull();
  });

  it("rejects a token signed with a different JWT header", async () => {
    const created = await createManagerSession();
    const parts = created.token.split(".");
    const alteredHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const tampered = `${alteredHeader}.${parts[1]}.${parts[2]}`;
    expect(verifyManagerToken(tampered)).toBeNull();
  });

  it("rejects a correctly signed token whose iat is too far in the future", async () => {
    const created = await createManagerSession();
    const parts = created.token.split(".");
    const header = parts[0];
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    payload.iat += 3600;
    const mutatedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const data = `${header}.${mutatedPayload}`;
    const signature = createHmac("sha256", process.env.GATEWAY_JWT_SECRET!)
      .update(data)
      .digest("base64url");
    expect(verifyManagerToken(`${data}.${signature}`)).toBeNull();
  });

  it("accepts a valid scrypt password hash", () => {
    const salt = "principal-audit-salt";
    const hash = scryptSync("correct-password", salt, 32).toString("hex");
    process.env.MANAGER_PASSWORD_HASH = `${salt}:${hash}`;
    expect(verifyManagerPassword("manager", "correct-password")).toBe(true);
    expect(verifyManagerPassword("manager", "wrong-password")).toBe(false);
  });

  it("rejects plaintext passwords in production", () => {
    delete process.env.MANAGER_PASSWORD_HASH;
    process.env.MANAGER_PASSWORD = "plain-password";
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyManagerPassword("manager", "plain-password")).toBe(false);
  });
});