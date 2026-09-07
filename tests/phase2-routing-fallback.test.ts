import { describe, expect, it } from "vitest";
import { validatePayloadForPrinter, isPrinterAvailableForJob, isAgentAvailableForPrinter } from "../src/lib/routing";

describe("runtime routing capability and availability", () => {
  it("allows image payloads for printers that advertise image support", () => {
    expect(validatePayloadForPrinter("image", {
      protocol: "ipp",
      connectionType: "ipp",
      capabilities: { supported_protocols: ["pdf", "image"] },
    }).ok).toBe(true);
  });

  it("converts image payloads when the printer can print PDF or ESC/POS", () => {
    expect(validatePayloadForPrinter("image", {
      protocol: "ipp",
      connectionType: "ipp",
      capabilities: { supported_protocols: ["pdf"] },
    }).ok).toBe(true);
    expect(validatePayloadForPrinter("image", {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw", "escpos"] },
    }).ok).toBe(true);
  });

  it("rejects image payloads when the printer cannot convert or render them", () => {
    const result = validatePayloadForPrinter("image", {
      protocol: "ipp",
      connectionType: "ipp",
      capabilities: { supported_protocols: ["unknown"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CAPABILITY_MISMATCH");
  });

  it("allows raw and escpos bytes for raw/spooler-compatible transports", () => {
    expect(validatePayloadForPrinter("raw", { protocol: "raw", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter("escpos", { protocol: "raw", connectionType: "network" }).ok).toBe(true);
    expect(validatePayloadForPrinter("raw", { protocol: "spooler", connectionType: "spooler" }).ok).toBe(true);
  });

  it("requires spooler or IPP transport for PDF", () => {
    expect(validatePayloadForPrinter("pdf", { protocol: "ipp", connectionType: "ipp" }).ok).toBe(true);
    expect(validatePayloadForPrinter("pdf", { protocol: "raw", connectionType: "network" }).ok).toBe(false);
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
