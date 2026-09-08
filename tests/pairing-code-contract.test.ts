import { describe, expect, it } from "vitest";
import { generatePairingCode, hashPairingCode, isValidPairingCode, PAIRING_CODE_PATTERN } from "../src/lib/agent-auth";

describe("pairing code contract", () => {
  it("generates 1000 codes accepted by the registration contract", () => {
    const codes = Array.from({ length: 1000 }, () => generatePairingCode());
    expect(codes.every((code) => PAIRING_CODE_PATTERN.test(code))).toBe(true);
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  it("uses the unambiguous alphabet shared by Gateway, Go and Tauri", () => {
    expect(isValidPairingCode("AB22CD")).toBe(true);
    expect(isValidPairingCode("ab22cd")).toBe(true);
    expect(isValidPairingCode("123456")).toBe(false);
    expect(isValidPairingCode("AB01CD")).toBe(false);
    expect(isValidPairingCode("ABIOCD")).toBe(false);
    expect(isValidPairingCode("ABCDE")).toBe(false);
    expect(isValidPairingCode("ABCDEFG")).toBe(false);
  });

  it("deterministically hashes normalized pairing codes with sha256", () => {
    const code = "AB22CD";
    const h1 = hashPairingCode(code);
    const h2 = hashPairingCode("ab22cd");
    const h3 = hashPairingCode("  ab22cd  ");
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).not.toBe(code);
  });
});
