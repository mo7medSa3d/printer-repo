import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const apiKeyFindFirst = vi.fn();
const apiKeyUpdate = vi.fn();

vi.mock("../src/db", () => ({
  db: {
    query: {
      apiKeys: { findFirst: (...args: unknown[]) => apiKeyFindFirst(...args) },
    },
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => apiKeyUpdate(...args),
      }),
    }),
  },
}));

import { isOdooDatabaseAllowed, validateOdooKey } from "../src/lib/odoo-auth";

describe("Odoo database tenant isolation", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    apiKeyFindFirst.mockReset();
    apiKeyUpdate.mockReset().mockResolvedValue(undefined);
  });

  it("allows exactly the configured Odoo database", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ODOO_DATABASE_NAME", "customer_a");

    expect(isOdooDatabaseAllowed("customer_a")).toBe(true);
    expect(isOdooDatabaseAllowed("customer_b")).toBe(false);
    expect(isOdooDatabaseAllowed("customer_a ")).toBe(true);
  });

  it("fails closed in production when the database binding is not configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ODOO_DATABASE_NAME", "");

    expect(isOdooDatabaseAllowed("customer_a")).toBe(false);
    expect(isOdooDatabaseAllowed(null)).toBe(false);
  });

  it("allows missing database binding only outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ODOO_DATABASE_NAME", "");

    expect(isOdooDatabaseAllowed(null)).toBe(true);
  });

  it("rejects a request from another Odoo database before key lookup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ODOO_DATABASE_NAME", "odoo_a");

    const req = new Request("https://gateway.test/api/print/jobs", {
      method: "POST",
      headers: {
        authorization: "Bearer odoo_testkey",
        "x-odoo-database": "odoo_b",
      },
    });

    await expect(validateOdooKey(req, "odoo_company_1")).resolves.toBeNull();
    expect(apiKeyFindFirst).not.toHaveBeenCalled();
  });

  it("accepts the same native company id only from the configured database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ODOO_DATABASE_NAME", "odoo_a");
    const hash = createHash("sha256").update("odoo_testkey").digest("hex");
    apiKeyFindFirst.mockResolvedValue({
      id: "key_a",
      branchId: "odoo_company_1",
      scope: "standard",
      allowedDocumentTypes: null,
      hashedKey: hash,
      revokedAt: null,
    });

    const reqA = new Request("https://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo_a" },
    });
    await expect(validateOdooKey(reqA, "odoo_company_1")).resolves.toMatchObject({ id: "key_a", branchId: "odoo_company_1" });

    const reqB = new Request("https://gateway.test/api/print/jobs", {
      method: "POST",
      headers: { authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo_b" },
    });
    await expect(validateOdooKey(reqB, "odoo_company_1")).resolves.toBeNull();

    expect(apiKeyFindFirst).toHaveBeenCalledTimes(1);
  });
});
