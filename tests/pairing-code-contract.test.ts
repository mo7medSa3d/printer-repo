import { describe, expect, it } from "vitest";
import { generatePairingCode, isValidPairingCode, PAIRING_CODE_PATTERN } from "../src/lib/agent-auth";

describe("pairing code contract", () => {
  it("generates 1000 codes accepted by the registration contract", () => {
    const codes = Array.from({ length: 1000 }, () => generatePairingCode());
    expect(codes.every((code) => PAIRING_CODE_PATTERN.test(code))).toBe(true);
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  it("uses the unambiguous alphabet shared by Gateway, Go and Tauri", () => {
    expect(isValidPairingCode("AB12CD")).toBe(true);
    expect(isValidPairingCode("ab12cd")).toBe(true);
    expect(isValidPairingCode("123456")).toBe(false);
    expect(isValidPairingCode("AB01CD")).toBe(false);
    expect(isValidPairingCode("ABIOCD")).toBe(false);
    expect(isValidPairingCode("ABCDE")).toBe(false);
    expect(isValidPairingCode("ABCDEFG")).toBe(false);
  });
});
