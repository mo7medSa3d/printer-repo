import { describe, expect, it } from "vitest";
import { isPrinterAvailableForJob } from "../src/lib/routing";
import { isVirtualPrinterRecord } from "../src/lib/printer-virtual";

const VIRTUAL = [
  { name: "Microsoft Print to PDF", record: { printerType: "virtual" } },
  { name: "Microsoft XPS Document Writer", record: { printerType: "virtual" } },
  { name: "OneNote", record: { printerType: "virtual" } },
  { name: "OneNote (Desktop)", record: { printerType: "virtual" } },
  { name: "Fax", record: { printerType: "virtual" } },
  { name: "RDP redirected queue", record: { printerType: "virtual" } },
  { name: "legacy row only matched by name", record: { name: "Microsoft Print to PDF" } },
  { name: "print-to-FILE port", record: { port: "FILE:" } },
  { name: "NUL: port", record: { port: "NUL:" } },
  { name: "PORTPROMPT: port", record: { port: "PORTPROMPT:" } },
  { name: "Foxit driver", record: { driverName: "Foxit PDF Printer" } },
  { name: "AnyDesk driver", record: { driverName: "AnyDesk Printer" } },
  { name: "Remote Desktop Easy Print driver", record: { driverName: "Remote Desktop Easy Print" } },
  { name: "Terminal Services Easy Print driver", record: { driverName: "Terminal Services Easy Print" } },
  { name: "Citrix driver", record: { driverName: "Citrix Universal Printer" } },
  { name: "VMware driver", record: { driverName: "VMware Universal Printer" } },
  { name: "Citrix (from host) in session", record: { name: "Citrix (from host) in session" } },
];

describe("printer virtual classification", () => {
  it.each(VIRTUAL)("hides '$name'", ({ record }) => {
    expect(isVirtualPrinterRecord(record)).toBe(true);
  });

  it("keeps 'physical USB printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "usb", name: "Epson" })).toBe(false);
  });

  it("keeps 'physical TCP/IP printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "tcp", name: "HP" })).toBe(false);
  });

  it("keeps 'physical IPP printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "ipp", name: "Brother" })).toBe(false);
  });

  it("keeps 'physical Windows spooler printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "spooler", name: "Canon" })).toBe(false);
  });

  it("keeps every legitimate hardware family routable", () => {
    for (const printerType of ["physical", "laser", "inkjet", "thermal", "receipt"]) {
      expect(isVirtualPrinterRecord({ printerType, connectionType: "tcp", name: `hardware-${printerType}` })).toBe(false);
    }
  });
});

describe("routing availability", () => {
  it("refuses a virtual printer even when it is online and enabled", () => {
    expect(
      isPrinterAvailableForJob({
        lifecycle: "active",
        status: "online",
        printerType: "virtual",
        name: "Microsoft Print to PDF",
      })
    ).toBe(false);
  });

  it("refuses a virtual printer detected only through capabilities", () => {
    expect(
      isPrinterAvailableForJob({
        lifecycle: "active",
        status: "unknown",
        capabilities: { virtual: true },
      })
    ).toBe(false);
  });

  it("keeps a physical printer available only with positive online telemetry", () => {
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "online", printerType: "physical", deviceClass: "laser" })
    ).toBe(true);
    // Unknown telemetry is intentionally unavailable: routing must not send a
    // job to a printer whose current health state has not been positively reported.
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "unknown", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "offline", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
    expect(
      isPrinterAvailableForJob({ lifecycle: "disabled", status: "online", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
  });
});

// The end-to-end routing behaviour (virtual candidate skipped, physical
// candidate chosen, PRINTER_VIRTUAL returned only when every candidate is
// virtual) is covered by tests/routing-virtual-regression.test.ts, which drives
// the real resolvePrinterForJob instead of asserting on source text.

describe("desktop manager safety net", () => {
  it.each(VIRTUAL)("hides $name from the printer list", ({ name, record }: { name: string; record: Record<string, unknown> }) => {
    const printer = {
      id: "p",
      name: record.name as string,
      printerType: record.printerType as string,
      connectionType: record.connectionType as string,
      port: record.port as string,
      driverName: record.driverName as string,
      capabilities: record.capabilities as Record<string, unknown>,
    };
    expect(isVirtualPrinterRecord(printer)).toBe(true);
  });
});
