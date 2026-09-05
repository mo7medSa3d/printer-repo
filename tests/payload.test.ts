import { describe, it, expect } from "vitest";
import { validatePrintJobPayload, buildTestPrintPayload } from "../src/lib/payload";

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
  it("validates pdf payload type only when bytes carry a PDF signature", () => {
    const pdf = { type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4").toString("base64") };
    expect(validatePrintJobPayload(pdf).type).toBe("pdf");
    expect(() => validatePrintJobPayload({ type: "pdf", encoding: "base64", data: Buffer.from("hello").toString("base64") })).toThrow(/PDF payload/);
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: Buffer.from("%PDF-1.7").toString("base64") })).toThrow(/PDF bytes/);
    expect(() => validatePrintJobPayload({ type: "escpos", encoding: "base64", data: Buffer.from("%PDF-1.7").toString("base64") })).toThrow(/PDF bytes/);
  });
  it("rejects bad type", () => {
    expect(() => validatePrintJobPayload({ type: "badtype", encoding: "base64", data: "aGVsbG8=" })).toThrow();
  });
  it("rejects non-canonical base64 the Go agent would also reject", () => {
    // Missing padding — Node's Buffer.from tolerates it, StdEncoding does not.
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGVsbG8" })).toThrow();
    // Out-of-alphabet characters (whitespace, stray symbols) are skipped by
    // Buffer.from but rejected by the agent's strict decoder.
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: " aGVsbG8= " })).toThrow();
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGVsbG8=!@#" })).toThrow();
    expect(() => validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGVs\nbG8=" })).toThrow();
  });
  it("accepts canonical base64 with padding", () => {
    expect(validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGVsbG8=" }).data).toBe("aGVsbG8=");
    expect(validatePrintJobPayload({ type: "raw", encoding: "base64", data: "aGk=" }).data).toBe("aGk=");
  });
  it("test payload is decodable and has cut command", () => {
    const p = buildTestPrintPayload("Receipt", "Main");
    const decoded = Buffer.from(p.data, "base64").toString("binary");
    expect(decoded).toContain("Odoo Print Agent");
    expect(decoded).toContain("\x1d\x56\x01");
  });
});
