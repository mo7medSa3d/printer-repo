import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
} from "@/lib/manager-auth";

const suite = describe.skipIf(!hasTestDatabase);

suite("manager authentication hardening", () => {
  beforeAll(async () => {
    process.env.GATEWAY_JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
    process.env.MANAGER_USERNAME = "manager";
    await applyMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await truncateAll();
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

  it("rejects a token with an iat too far in the future", async () => {
    const created = await createManagerSession();
    const parts = created.token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    payload.iat += 3600;
    const mutatedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mutated = `${parts[0]}.${mutatedPayload}.${parts[2]}`;
    expect(verifyManagerToken(mutated)).toBeNull();
  });

  it("accepts hashed passwords and rejects plaintext passwords in production", () => {
    process.env.MANAGER_PASSWORD_HASH = "salt:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.MANAGER_PASSWORD = "plain-password";
    const expectedUser = process.env.MANAGER_USERNAME!;
    expect(verifyManagerPassword(expectedUser, "plain-password")).toBe(false);
    delete process.env.MANAGER_PASSWORD_HASH;
    process.env.NODE_ENV = "production";
    expect(verifyManagerPassword(expectedUser, "plain-password")).toBe(false);
    delete process.env.MANAGER_PASSWORD;
    process.env.NODE_ENV = "test";
  });
});
