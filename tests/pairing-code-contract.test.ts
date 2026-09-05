import { describe, expect, it } from "vitest";
import { generatePairingCode } from "../src/lib/agent-auth";

const pairingCodePattern = /^\d{6}$/;

describe("pairing code contract", () => {
  it("generates 1000 codes accepted by the registration contract", () => {
    const codes = Array.from({ length: 1000 }, () => generatePairingCode());
    expect(codes.every((code) => pairingCodePattern.test(code))).toBe(true);
    expect(codes.every((code) => code.length === 6)).toBe(true);
  });

  it("preserves leading zeroes", () => {
    expect(generatePairingCode()).toMatch(pairingCodePattern);
  });
});
