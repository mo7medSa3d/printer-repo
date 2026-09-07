import { describe, expect, it } from "vitest";
import { isPrinterAvailableForJob, validatePayloadForPrinter } from "../src/lib/routing";

function printer(overrides: Record<string, unknown> = {}) {
  return {
    id: "printer-1", agentId: "agent-1", name: "Physical Printer", printerType: "physical", deviceClass: "thermal",
    connectionType: "network", protocol: "raw", lifecycle: "active", status: "online", capabilities: null, config: {},
    ...overrides,
  };
}

describe("runtime printer routing regressions", () => {
  it("keeps active physical printers routable", () => {
    expect(isPrinterAvailableForJob(printer())).toBe(true);
  });

  it("does not treat virtual printers as physical execution targets", () => {
    expect(isPrinterAvailableForJob(printer({ printerType: "virtual" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ printerType: "virtual", connectionType: "spooler", protocol: "spooler" }))).toBe(false);
  });

  it("rejects offline and disabled printers before execution", () => {
    expect(isPrinterAvailableForJob(printer({ status: "offline" }))).toBe(false);
    expect(isPrinterAvailableForJob(printer({ lifecycle: "disabled" }))).toBe(false);
  });

  it("does not silently accept a payload capability the printer cannot convert or render", () => {
    const result = validatePayloadForPrinter("pdf", {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw", "escpos"] },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts POS JPEG payloads for thermal printers the Agent can rasterize", () => {
    const result = validatePayloadForPrinter("image", {
      protocol: "raw",
      connectionType: "network",
      capabilities: { supported_protocols: ["raw", "escpos"] },
    });
    expect(result.ok).toBe(true);
  });
});
