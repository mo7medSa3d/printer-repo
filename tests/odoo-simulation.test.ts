import { describe, it, expect } from "vitest";
import { validatePrintJobPayload, buildTestPrintPayload } from "../src/lib/payload";

// Payload-contract unit tests for the exact JSON Odoo submits to
// POST /api/print/jobs. The FULL flow (auth, idempotency, status
// transitions) is exercised against real PostgreSQL by
// tests/e2e-job-flow.test.ts and tests/ws-claim-delivery.test.ts; the
// byte-level agent parity is proven in Go by
// agent/internal/integration/mock_e2e_test.go. This file contains ONLY
// the always-executable unit layer - no placeholders, no fake parity.
describe("Odoo simulation — POST /api/print/jobs payload contract", () => {
  it("validates payload contract (raw/escpos/pdf base64, 5MiB cap)", () => {
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") })).not.toThrow();
    expect(() => validatePrintJobPayload({ type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4").toString("base64") })).not.toThrow();
    expect(() => validatePrintJobPayload({ type: "badtype", encoding: "base64", data: "aGVsbG8=" })).toThrow();
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "hex", data: "aGVsbG8=" })).toThrow();
    const huge = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: huge })).toThrow();
  });

  it("rejects raw payloads without an explicit protocol (no inference)", () => {
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGVsbG8=" })).toThrow(/protocol/);
    expect(() => validatePrintJobPayload({ type: "escpos", encoding: "base64", data: "aGVsbG8=" })).toThrow(/protocol/);
    expect(() => validatePrintJobPayload({ type: "escpos", protocol: "zpl", encoding: "base64", data: "aGVsbG8=" })).toThrow(/protocol/);
    expect(() => validatePrintJobPayload({ type: "pdf", protocol: "raw", encoding: "base64", data: Buffer.from("%PDF-1.4").toString("base64") })).toThrow(/protocol/);
    expect(() => validatePrintJobPayload({ type: "image", protocol: "escpos", encoding: "base64", data: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64") })).toThrow(/protocol/);
  });

  it("builds realistic Odoo ESC/POS payload that decodes to printable bytes", () => {
    const p = buildTestPrintPayload("Receipt", "Main Office");
    const decoded = Buffer.from(p.data, "base64").toString("binary");
    expect(p.type).toBe("escpos");
    expect(p.protocol).toBe("escpos");
    expect(decoded).toContain("Odoo Print Agent");
    expect(decoded).toContain("\x1d\x56\x01"); // cut
  });
});
