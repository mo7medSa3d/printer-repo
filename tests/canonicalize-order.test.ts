import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/lib/canonicalize";
import { idempotencyFingerprint } from "../src/lib/print-job-service";

describe("canonicalize (idempotency fingerprint ordering, audit P3-04)", () => {
  it("sorts object keys by codepoint order, not locale collation", () => {
    // 'B' (0x42) sorts before 'a' (0x61) by codepoint; ICU localeCompare
    // inverts this, which used to make idempotency fingerprints
    // locale/runtime dependent.
    const sorted = Object.keys(canonicalize({ a: 1, B: 2 }) as Record<string, unknown>);
    expect(sorted).toEqual(["B", "a"]);
  });

  it("is deterministic regardless of input key order, including nesting", () => {
    const left = { type: "raw", protocol: "raw", encoding: "base64", data: "eA==" };
    const right = { data: "eA==", encoding: "base64", protocol: "raw", type: "raw" };
    expect(JSON.stringify(canonicalize(left))).toBe(JSON.stringify(canonicalize(right)));
    const nestedL = { peripherals: { cutter: "full", drawer: "pin2" }, data: "eA==" };
    const nestedR = { data: "eA==", peripherals: { drawer: "pin2", cutter: "full" } };
    expect(JSON.stringify(canonicalize(nestedL))).toBe(JSON.stringify(canonicalize(nestedR)));
  });

  it("keeps arrays order-sensitive (documents are ordered byte streams)", () => {
    expect(JSON.stringify(canonicalize([2, 1]))).not.toBe(JSON.stringify(canonicalize([1, 2])));
  });

  it("fingerprint ignores key order but not content changes", () => {
    const base = { printerId: "printer_1", documentType: "receipt", destination: "Main", payload: { type: "raw", protocol: "raw", encoding: "base64", data: "eA==" } };
    const reordered = { destination: "Main", documentType: "receipt", printerId: "printer_1", payload: { data: "eA==", encoding: "base64", protocol: "raw", type: "raw" } };
    expect(idempotencyFingerprint(reordered)).toBe(idempotencyFingerprint(base));
    const changed = { ...base, payload: { ...base.payload, data: "eQ==" } };
    expect(idempotencyFingerprint(changed)).not.toBe(idempotencyFingerprint(base));
  });
});
