import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const apiKeyFindFirst = vi.fn();
const apiKeyUpdate = vi.fn();

vi.mock("../src/db", () => ({
  db: {
    query: { apiKeys: { findFirst: (...args: unknown[]) => apiKeyFindFirst(...args) } },
    update: () => ({ set: () => ({ where: (...args: unknown[]) => apiKeyUpdate(...args) }) }),
  },
}));

import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "../src/lib/odoo-auth";

// Odoo Gateway authentication is based on the Odoo installation API key.
// The Odoo database name is not used as an authentication requirement:
// X-Odoo-Database may be sent for informational purposes and is ignored.
describe("Odoo API-key authentication ignores the database name", () => {
  const hash = createHash("sha256").update("odoo_testkey").digest("hex");
  const liveRow = {
    id: "key_a",
    scope: "standard",
    allowedDocumentTypes: null,
    hashedKey: hash,
    revokedAt: null,
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    apiKeyFindFirst.mockReset();
    apiKeyUpdate.mockReset().mockResolvedValue(undefined);
    apiKeyFindFirst.mockResolvedValue(liveRow);
  });

  const post = (headers: Record<string, string>) =>
    new Request("https://gateway.test/api/print/jobs", { method: "POST", headers });

  it("accepts a valid key with X-Odoo-Database: odoo-db", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key with a different database name", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "anything-else" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key when X-Odoo-Database is missing", async () => {
    const req = post({ authorization: "Bearer odoo_testkey" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("accepts a valid key via X-Api-Key regardless of database name", async () => {
    const req = post({ "x-api-key": "odoo_testkey", "x-odoo-database": "another-db" });
    await expect(validateOdooKey(req)).resolves.toMatchObject({ id: "key_a" });
  });

  it("still performs the API-key lookup even when the database differs", async () => {
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "unrelated-db" });
    await validateOdooKey(req);
    expect(apiKeyFindFirst).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid API key", async () => {
    apiKeyFindFirst.mockResolvedValue(null);
    const req = post({ authorization: "Bearer odoo_wrongkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("rejects a revoked API key", async () => {
    apiKeyFindFirst.mockResolvedValue({ ...liveRow, revokedAt: new Date() });
    const req = post({ authorization: "Bearer odoo_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
  });

  it("rejects keys without the odoo_ prefix", async () => {
    const req = post({ authorization: "Bearer other_testkey", "x-odoo-database": "odoo-db" });
    await expect(validateOdooKey(req)).resolves.toBeNull();
    expect(apiKeyFindFirst).not.toHaveBeenCalled();
  });

  it("keeps API-key scope and document-type restrictions", () => {
    expect(
      isOdooKeyAllowedForDocumentType({ scope: "read_only", allowedDocumentTypes: null }, "receipt", "write"),
    ).toBe(false);
    expect(
      isOdooKeyAllowedForDocumentType({ scope: "standard", allowedDocumentTypes: ["receipt"] }, "label", "read"),
    ).toBe(false);
    expect(
      isOdooKeyAllowedForDocumentType({ scope: "standard", allowedDocumentTypes: ["receipt"] }, "receipt", "read"),
    ).toBe(true);
  });
});
