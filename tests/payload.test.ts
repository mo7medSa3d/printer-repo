import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { validatePrintJobPayload, buildTestPrintPayload, printJobPayloadSchema } from "../src/lib/payload";

describe("payload", () => {
  it("wire payload types are identical in TypeScript, Go and Odoo (no jpeg/raster drift)", () => {
    // The ONLY legal wire types. "jpeg"/"raster_jpeg" are internal column
    // names on the Odoo side, never payload types: a drift here means a
    // valid persisted Odoo job 422s at the Gateway (or vice versa).
    const tsTypes = (printJobPayloadSchema.shape.type as unknown as { options: string[] }).options;
    expect([...tsTypes].sort()).toEqual(["escpos", "image", "pdf", "raw"]);
    const go = readFileSync("agent/internal/payload/payload.go", "utf8");
    for (const decl of ['TypeRaw    Type = "raw"', 'TypeESCPOS Type = "escpos"', 'TypePDF    Type = "pdf"', 'TypeImage  Type = "image"']) {
      expect(go).toContain(decl);
    }
    expect(go).not.toContain('"jpeg"');
    expect(go).not.toContain('"raster_jpeg"');
    const odoo = readFileSync("odoo_addons/print_gateway/models/print_job.py", "utf8");
    const mapBlock = odoo.slice(odoo.indexOf("_PAYLOAD_TYPE_MAP = {"), odoo.indexOf("}", odoo.indexOf("_PAYLOAD_TYPE_MAP = {")));
    // The map KEYS must be exactly the four wire types (values are the
    // internal payload_type column names, which legitimately differ).
    const mapKeys = [...mapBlock.matchAll(/"(\w+)":/g)].map((m) => m[1]);
    expect(mapKeys.sort()).toEqual(["escpos", "image", "pdf", "raw"]);
    // And the payload body field is always "data" (no "base64" alias).
    expect(odoo).not.toContain('payload.get("base64")');
  });
  it("validates raw and escpos", () => {
    const raw = { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from("hello").toString("base64") };
    expect(validatePrintJobPayload(raw).type).toBe("raw");
    const esc = buildTestPrintPayload("Printer1", "Agent1");
    expect(validatePrintJobPayload(esc).type).toBe("escpos");
  });
  it("rejects oversized", () => {
    const huge = Buffer.alloc(6 * 1024 * 1024).toString("base64");
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: huge })).toThrow();
  });
  it("validates pdf payload type only when bytes carry a PDF signature", () => {
    const pdf = { type: "pdf", encoding: "base64", data: Buffer.from("%PDF-1.4").toString("base64") };
    expect(validatePrintJobPayload(pdf).type).toBe("pdf");
    expect(() => validatePrintJobPayload({ type: "pdf", encoding: "base64", data: Buffer.from("hello").toString("base64") })).toThrow(/PDF payload/);
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from("%PDF-1.7").toString("base64") })).toThrow(/PDF bytes/);
    expect(() => validatePrintJobPayload({ type: "escpos", protocol: "escpos", encoding: "base64", data: Buffer.from("%PDF-1.7").toString("base64") })).toThrow(/PDF bytes/);
  });
  it("rejects bad type", () => {
    expect(() => validatePrintJobPayload({ type: "badtype", encoding: "base64", data: "aGVsbG8=" })).toThrow();
  });
  it("rejects non-canonical base64 the Go agent would also reject", () => {
    // Missing padding — Node's Buffer.from tolerates it, StdEncoding does not.
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8" })).toThrow();
    // Out-of-alphabet characters (whitespace, stray symbols) are skipped by
    // Buffer.from but rejected by the agent's strict decoder.
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: " aGVsbG8= " })).toThrow();
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=!@#" })).toThrow();
    expect(() => validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: "aGVs\nbG8=" })).toThrow();
  });
  it("accepts canonical base64 with padding", () => {
    expect(validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" }).data).toBe("aGVsbG8=");
    expect(validatePrintJobPayload({ type: "raw", protocol: "raw", encoding: "base64", data: "aGk=" }).data).toBe("aGk=");
  });
  it("test payload is decodable and has cut command", () => {
    const p = buildTestPrintPayload("Receipt", "Main");
    const decoded = Buffer.from(p.data, "base64").toString("binary");
    expect(decoded).toContain("Odoo Print Agent");
    expect(decoded).toContain("\x1d\x56\x01");
  });
  it("test payload never embeds control bytes from user-controlled names", () => {
    const p = buildTestPrintPayload("ACME\x1b@Corp\x00Ltd", 'Agent"\x1b');
    const decoded = Buffer.from(p.data, "base64").toString("binary");
    // Our own ticket sequences survive; the injected ones do not.
    expect(decoded).toContain("Printer: ACME@CorpLtd");
    expect(decoded).toContain('Agent: Agent"');
    const stripped = decoded.replace(/\x1b\x40/g, "").replace(/\x1b\x61[\x00\x01]/g, "").replace(/\x1d\x56\x01/g, "");
    // Newlines are the ticket's own formatting; every other C0 control
    // (incl. ESC) injected via names must be gone.
    expect(stripped).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  });
});
