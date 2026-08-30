import { describe, it, expect } from "vitest";
import { validatePrintJobPayload, buildTestPrintPayload } from "@/lib/payload";

describe("payload", () => {
  it("validates raw and escpos", () => {
    const raw = { type: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") };
    expect(validatePrintJobPayload(raw).type).toBe("raw");
    const esc = buildTestPrintPayload("Printer1", "Agent1");
    expect(validatePrintJobPayload(esc).type).toBe("escpos");
  });
  it("rejects oversized", () => {
    const huge = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: huge })).toThrow();
  });
  it("rejects bad type", () => {
    expect(() => validatePrintJobPayload({ type: "pdf", encoding: "base64", data: "aGVsbG8=" })).toThrow();
  });
  it("test payload is decodable and has cut command", () => {
    const p = buildTestPrintPayload("Receipt", "Main");
    const decoded = Buffer.from(p.data, "base64").toString("binary");
    expect(decoded).toContain("Odoo Print Agent");
    expect(decoded).toContain("\x1d\x56\x01");
  });
});
