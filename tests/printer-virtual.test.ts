import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isVirtualPrinterRecord,
  isRoutablePrinterRecord,
} from "@/lib/printer-virtual";
import { isPrinterAvailableForJob } from "@/lib/routing";
import { isVirtualPrinter, isProductionPrinter } from "@/desktop/lib/printers";

/**
 * Virtual / software printer guard.
 *
 * Only real printing hardware may be a production route. These tests cover
 * both ends of the pipeline:
 *
 *   - the Gateway routing layer, which must refuse a virtual printer even if
 *     an older agent version already registered one;
 *   - the Desktop Manager safety net, which must never render such a queue.
 *
 * The authoritative classification lives in the Windows agent
 * (agent/internal/printer/classify_device.go, tested there).
 */

const VIRTUAL = [
  {
    name: "Microsoft Print to PDF",
    record: {
      name: "Microsoft Print to PDF",
      printerType: "virtual",
      connectionType: "spooler",
      capabilities: { port_name: "PORTPROMPT:", driver_name: "Microsoft Print To PDF" },
    },
  },
  {
    name: "Microsoft XPS Document Writer",
    record: {
      name: "Microsoft XPS Document Writer",
      printerType: "virtual",
      connectionType: "spooler",
      capabilities: { port_name: "XPSPort:" },
    },
  },
  {
    name: "OneNote",
    record: { name: "OneNote", connectionType: "spooler", printerType: "virtual" },
  },
  {
    name: "OneNote (Desktop)",
    record: { name: "OneNote (Desktop)", connectionType: "spooler", printerType: "virtual" },
  },
  {
    name: "Fax",
    record: {
      name: "Fax",
      connectionType: "spooler",
      capabilities: { port_name: "SHRFAX:", driver_name: "Microsoft Shared Fax Driver" },
    },
  },
  {
    name: "RDP redirected queue",
    record: {
      name: "HP LaserJet 1020 (redirected 3)",
      connectionType: "spooler",
      capabilities: { printer_class: "redirected" },
    },
  },
  {
    name: "legacy row only matched by name",
    record: { name: "Microsoft Print to PDF", connectionType: "spooler" },
  },
];

const PHYSICAL = [
  {
    name: "physical USB printer",
    record: {
      name: "HP LaserJet Pro M404",
      printerType: "laser",
      connectionType: "spooler",
      capabilities: { port_name: "USB001", driver_name: "HP LaserJet Pro M404 PCL 6" },
    },
  },
  {
    name: "physical TCP/IP printer",
    record: {
      name: "Zebra ZD421",
      printerType: "label",
      connectionType: "network",
      capabilities: { printer_class: "physical" },
    },
  },
  {
    name: "physical IPP printer",
    record: {
      name: "Canon i-SENSYS",
      printerType: "laser",
      connectionType: "ipp",
      capabilities: { printer_class: "physical" },
    },
  },
  {
    name: "physical Windows spooler printer",
    record: {
      name: "Brother HL-L2360D",
      printerType: "laser",
      connectionType: "spooler",
      capabilities: { port_name: "BRN30055C4B5B4C", printer_class: "physical" },
    },
  },
];

describe("virtual printers are never production routes", () => {
  it.each(VIRTUAL)("hides $name", ({ record }) => {
    expect(isVirtualPrinterRecord(record)).toBe(true);
    expect(isRoutablePrinterRecord(record)).toBe(false);
  });

  it.each(PHYSICAL)("keeps $name", ({ record }) => {
    expect(isVirtualPrinterRecord(record)).toBe(false);
    expect(isRoutablePrinterRecord(record)).toBe(true);
  });

  it("treats missing records as non-virtual", () => {
    expect(isVirtualPrinterRecord(null)).toBe(false);
    expect(isVirtualPrinterRecord(undefined)).toBe(false);
    expect(isVirtualPrinterRecord({})).toBe(false);
  });

  it("keeps every legitimate hardware family routable", () => {
    const fleet = [
      "HP LaserJet Pro M404",
      "Brother HL-L2360D series",
      "Epson TM-T82II",
      "Zebra ZD421",
      "Canon i-SENSYS MF643",
      "Xerox VersaLink C405",
      "Ricoh MP C3004",
      "Kyocera ECOSYS P3145dn",
      "Bixolon SRP-350III",
    ];
    for (const name of fleet) {
      expect(
        isVirtualPrinterRecord({ name, connectionType: "spooler", printerType: "laser" }),
        `${name} must stay routable`
      ).toBe(false);
    }
  });
});

describe("routing availability", () => {
  it("refuses a virtual printer even when it is online and enabled", () => {
    expect(
      isPrinterAvailableForJob({
        enabled: true,
        status: "online",
        printerType: "virtual",
        name: "Microsoft Print to PDF",
      })
    ).toBe(false);
  });

  it("refuses a virtual printer detected only through capabilities", () => {
    expect(
      isPrinterAvailableForJob({
        enabled: true,
        status: "unknown",
        capabilities: { virtual: true },
      })
    ).toBe(false);
  });

  it("keeps a physical printer available", () => {
    expect(
      isPrinterAvailableForJob({ enabled: true, status: "online", printerType: "laser" })
    ).toBe(true);
    expect(
      isPrinterAvailableForJob({ enabled: true, status: "unknown", printerType: "laser" })
    ).toBe(true);
    expect(
      isPrinterAvailableForJob({ enabled: true, status: "offline", printerType: "laser" })
    ).toBe(false);
    expect(
      isPrinterAvailableForJob({ enabled: false, status: "online", printerType: "laser" })
    ).toBe(false);
  });
});

describe("routing resolves around virtual printers", () => {
  const routingSrc = readFileSync("src/lib/routing.ts", "utf8");
  const jobsRouteSrc = readFileSync("src/app/api/print/jobs/route.ts", "utf8");

  it("consults the virtual guard while evaluating bindings", () => {
    expect(routingSrc).toContain("isVirtualPrinterRecord(printer)");
    expect(routingSrc).toContain("isVirtualPrinterRecord(printer)");
    expect(routingSrc).toContain("PRINTER_VIRTUAL");
  });

  it("maps PRINTER_VIRTUAL to HTTP 409 like other configuration problems", () => {
    expect(jobsRouteSrc).toContain("PRINTER_VIRTUAL: 409");
  });

  it("guards the legacy printerId print path too", () => {
    expect(jobsRouteSrc).toContain("PRINTER_VIRTUAL: printer is virtual or redirected");
  });
});

describe("desktop manager safety net", () => {
  it.each(VIRTUAL)("hides $name from the printer list", ({ record }) => {
    const printer = {
      id: "p",
      name: record.name as string,
      status: "online",
      enabled: true,
      printer_type: record.printerType as string | undefined,
      connection_type: record.connectionType as string | undefined,
      capabilities: record.capabilities as Record<string, unknown> | undefined,
      isVirtual: (record.capabilities as Record<string, unknown> | undefined)?.virtual === true,
    };
    expect(isVirtualPrinter(printer)).toBe(true);
    expect(isProductionPrinter(printer)).toBe(false);
  });

  it.each(PHYSICAL)("keeps $name in the printer list", ({ record }) => {
    const printer = {
      id: "p",
      name: record.name as string,
      status: "online",
      enabled: true,
      printer_type: record.printerType as string | undefined,
      connection_type: record.connectionType as string | undefined,
      capabilities: record.capabilities as Record<string, unknown> | undefined,
    };
    expect(isVirtualPrinter(printer)).toBe(false);
    expect(isProductionPrinter(printer)).toBe(true);
  });

  it("honours the isVirtual flag persisted by an older version", () => {
    expect(
      isVirtualPrinter({
        id: "p",
        name: "Some Legacy Queue",
        status: "online",
        enabled: true,
        isVirtual: true,
      })
    ).toBe(true);
  });

  it("hides queues flagged through snake_case metadata", () => {
    expect(
      isVirtualPrinter({
        id: "p",
        name: "Legacy Queue",
        status: "online",
        enabled: true,
        is_virtual: true,
      } as never)
    ).toBe(true);
  });
});
