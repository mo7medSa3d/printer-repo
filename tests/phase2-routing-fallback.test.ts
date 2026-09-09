import { describe, expect, it } from "vitest";
import { validatePayloadForPrinter, isPrinterAvailableForJob, isAgentAvailableForPrinter } from "../src/lib/routing";

/**
 * The capability model is EXPLICIT: protocols never wildcard, missing
 * protocols never default, and byte-stream payloads are accepted only by
 * devices that declare that same protocol (directly or via
 * supported_protocols capabilities).
 */
describe("runtime routing capability and availability", () => {
  it("rejects a raw payload that does not declare an explicit protocol", () => {
    const result = validatePayloadForPrinter({ type: "raw" }, {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must declare an explicit protocol");
  });

  it("accepts image payloads for printers whose transport can render them", () => {
    expect(validatePayloadForPrinter({ type: "image" }, {
      protocol: "ipp",
      connectionType: "ipp",
      capabilities: { supported_protocols: ["pdf", "image"] },
    }).ok).toBe(true);
    // An explicitly ESC/POS device raster-converts JPEGs.
    expect(validatePayloadForPrinter({ type: "image" }, {
      protocol: "escpos",
      connectionType: "network",
      capabilities: null,
    }).ok).toBe(true);
  });

  it("rejects image payloads when the printer explicitly lacks image support", () => {
    const result = validatePayloadForPrinter({ type: "image" }, {
      protocol: "ipp",
      connectionType: "ipp",
      capabilities: { supported_protocols: ["pdf"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CAPABILITY_MISMATCH");
  });

  it("never lets a raw device act as a protocol wildcard", () => {
    // Generic RAW bytes require a device declared raw.
    expect(validatePayloadForPrinter({ type: "raw", protocol: "raw" }, { protocol: "raw", connectionType: "network" }).ok).toBe(true);
    // ...but ZPL/TSPL/ESC/POS bytes do NOT ride the generic raw channel.
    for (const proto of ["zpl", "tspl", "escpos"]) {
      const r = validatePayloadForPrinter({ type: "raw", protocol: proto }, {
        protocol: "raw",
        connectionType: "network",
        capabilities: { supported_protocols: ["raw"] },
      });
      expect(r.ok).toBe(false);
    }
  });

  it("requires ESC/POS devices for ESC/POS payloads (no spooler wildcard)", () => {
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { protocol: "escpos", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "raw", protocol: "escpos" }, { protocol: "escpos", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { protocol: "zpl", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { protocol: "spooler", connectionType: "spooler" }).ok).toBe(false);
    // unless the operator explicitly declares the capability:
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, {
      protocol: "spooler", connectionType: "spooler", capabilities: { supported_protocols: ["escpos"] },
    }).ok).toBe(true);
  });

  it("requires ZPL/TSPL devices for ZPL/TSPL payloads", () => {
    expect(validatePayloadForPrinter({ type: "raw", protocol: "zpl" }, { protocol: "zpl", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "raw", protocol: "tspl" }, { protocol: "tspl", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "raw", protocol: "zpl" }, { protocol: "tspl", connectionType: "network" }).ok).toBe(false);
  });

  it("requires spooler or IPP transport for PDF", () => {
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "ipp", connectionType: "ipp" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "spooler", connectionType: "spooler" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "raw", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "pdf", protocol: "raw" }, { protocol: "spooler", connectionType: "spooler" }).ok).toBe(false);
  });

  it("treats an undeclared printer protocol as unroutable", () => {
    // Authoritative unknown rule: unknown+network/usb invents nothing (all
    // byte protocols and pdf/image stay rejected); unknown+spooler/ipp
    // behaves as that DOCUMENT transport because the connection itself is
    // the explicit transport declaration.
    expect(validatePayloadForPrinter({ type: "raw", protocol: "raw" }, { protocol: "unknown", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "raw", protocol: "escpos" }, { protocol: "unknown", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { protocol: "unknown", connectionType: "usb" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "unknown", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "image" }, { protocol: "unknown", connectionType: "network" }).ok).toBe(false);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "unknown", connectionType: "spooler" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "image" }, { protocol: "unknown", connectionType: "spooler" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "unknown", connectionType: "ipp" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "escpos", protocol: "escpos" }, { protocol: "unknown", connectionType: "spooler" }).ok).toBe(false);
    // ipp and ipps are the same document transport everywhere they are
    // checked: explicit caps, transport default, and unknown fallback.
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "ipps", connectionType: "ipps" }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "pdf" }, { protocol: "raw", connectionType: "network", capabilities: { supported_protocols: ["ipps"] } }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "image" }, { protocol: "raw", connectionType: "network", capabilities: { supported_protocols: ["ipps"] } }).ok).toBe(true);
    expect(validatePayloadForPrinter({ type: "image" }, { protocol: "raw", connectionType: "network", capabilities: { supported_protocols: ["ipp"] } }).ok).toBe(true);
  });

  it("treats lifecycle and online telemetry as hard availability gates", () => {
    const base = {
      agentId: "a1",
      name: "P",
      printerType: "physical" as const,
      deviceClass: "thermal" as const,
      connectionType: "network" as const,
      protocol: "raw" as const,
      capabilities: null,
      config: {},
    };
    expect(isPrinterAvailableForJob({ ...base, lifecycle: "active", status: "online" })).toBe(true);
    expect(isPrinterAvailableForJob({ ...base, lifecycle: "active", status: "offline" })).toBe(false);
    expect(isPrinterAvailableForJob({ ...base, lifecycle: "disabled", status: "online" })).toBe(false);
  });

  it("requires a recently seen active agent", () => {
    const now = new Date();
    expect(isAgentAvailableForPrinter({ lifecycle: "active", status: "online", lastSeenAt: now })).toBe(true);
    expect(isAgentAvailableForPrinter({ lifecycle: "active", status: "offline", lastSeenAt: now })).toBe(false);
    expect(isAgentAvailableForPrinter({ lifecycle: "disabled", status: "online", lastSeenAt: now })).toBe(false);
  });
});
