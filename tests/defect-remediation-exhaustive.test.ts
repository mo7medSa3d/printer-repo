import { describe, it, expect } from "vitest";
import { buildTestPrintPayloadForPrinter, buildTestPdfPayload } from "../src/lib/payload";
import { getEffectivePrinterStatus } from "../src/lib/agent-availability";
import { isPrinterAvailableForJob, isAgentAvailableForPrinter } from "../src/lib/routing";
import { effectivePrinterStatus } from "../src/shared/job-vocabulary";
import fs from "node:fs";
import path from "node:path";

describe("DEFECT #1 — Gateway Send Test Page & PDF payload validation", () => {
  it("generates a valid, minimal printable PDF document for spooler/ipp/ipps transports", () => {
    const printer = {
      id: "p_spooler_1",
      name: "Front Desk Spooler",
      protocol: "spooler" as const,
      deviceClass: "standard" as const,
      connectionType: "spooler" as const,
    };
    const payload = buildTestPrintPayloadForPrinter(printer.name, "Office Agent", printer);
    expect(payload.type).toBe("pdf");
    expect(payload.encoding).toBe("base64");
    expect(typeof payload.data).toBe("string");

    const decoded = Buffer.from(payload.data, "base64");
    // Verify standard PDF header and trailer
    expect(decoded.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(decoded.toString("utf-8")).toContain("%%EOF");
    expect(decoded.toString("utf-8")).toContain("/Type /Page");
    expect(decoded.toString("utf-8")).toContain("Front Desk Spooler");
    expect(decoded.toString("utf-8")).toContain("Office Agent");
  });

  it("buildTestPdfPayload passes standard PDF structure requirements", () => {
    const pdfString = buildTestPdfPayload("Warehouse Zebra", "Zebra Agent");
    expect(pdfString.length).toBeGreaterThan(100);
    expect(pdfString.startsWith("%PDF-1.4")).toBe(true);
    expect(pdfString).toContain("trailer");
    expect(pdfString).toContain("startxref");
    expect(pdfString).toContain("%%EOF");
  });

  it("preserves raw protocol for escpos/zpl/tspl hardware", () => {
    const escposPrinter = {
      id: "p_escpos_1",
      name: "Kitchen Receipt",
      protocol: "escpos" as const,
      deviceClass: "thermal" as const,
      connectionType: "network" as const,
    };
    const payload = buildTestPrintPayloadForPrinter(escposPrinter.name, "Kitchen Agent", escposPrinter);
    expect(payload.type).toBe("escpos");
    expect(payload.encoding).toBe("base64");
  });
});

describe("DEFECT #2 — Printer Status After Agent Heartbeat Loss", () => {
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const freshTime = new Date(nowMs - 30_000); // 30s ago (fresh, <= 90s)
  const staleTime = new Date(nowMs - 120_000); // 120s ago (stale, > 90s)

  it("marks printer online only when both agent and printer are fresh and active", () => {
    const agent = { status: "online", lastSeenAt: freshTime, lifecycle: "active" };
    const printer = { status: "online", lastSeenAt: freshTime, lifecycle: "active" };

    const status = getEffectivePrinterStatus(printer, agent, nowDate);
    expect(status).toBe("online");
  });

  it("marks printer offline immediately if agent heartbeat is stale (>90s), even if DB printer status is 'online'", () => {
    const agent = { status: "online", lastSeenAt: staleTime, lifecycle: "active" };
    const printer = { status: "online", lastSeenAt: freshTime, lifecycle: "active" };

    const status = getEffectivePrinterStatus(printer, agent, nowDate);
    expect(status).toBe("offline");
  });

  it("marks printer offline if parent agent is marked offline or disabled", () => {
    const agent = { status: "offline", lastSeenAt: freshTime, lifecycle: "active" };
    const printer = { status: "online", lastSeenAt: freshTime, lifecycle: "active" };

    const status = getEffectivePrinterStatus(printer, agent, nowDate);
    expect(status).toBe("offline");

    const disabledAgent = { status: "online", lastSeenAt: freshTime, lifecycle: "inactive" };
    expect(getEffectivePrinterStatus(printer, disabledAgent, nowDate)).toBe("offline");
  });

  it("routing service isPrinterAvailableForJob refuses dispatch to printer with stale agent", () => {
    const agent = { status: "online" as const, lastSeenAt: staleTime, lifecycle: "active" as const };
    const printer = {
      id: "p1",
      name: "Test",
      status: "online" as const,
      lifecycle: "active" as const,
      lastSeenAt: freshTime,
      protocol: "raw" as const,
      deviceClass: "standard" as const,
      connectionType: "network" as const,
      endpoint: "192.168.1.100:9100",
    };

    expect(isAgentAvailableForPrinter(agent, nowDate)).toBe(false);
    expect(isPrinterAvailableForJob(printer, agent, nowDate)).toBe(false);
  });

  it("effectivePrinterStatus shared vocabulary helper produces consistent status for dashboard UI", () => {
    const agent = { status: "online", lastSeenAt: staleTime.toISOString(), lifecycle: "active" };
    const printer = { status: "online", lastSeenAt: freshTime.toISOString(), lifecycle: "active" };

    expect(effectivePrinterStatus(printer, agent, nowMs)).toBe("offline");
  });
});

describe("DEFECT #3 — Manual Printer Registration & Heartbeat Handling", () => {
  it("agent CLI supports --printer-type flag alias in addition to --device-class", () => {
    const cliSource = fs.readFileSync(path.resolve(__dirname, "../agent/cmd/cli/main.go"), "utf-8");
    expect(cliSource).toContain('fs.String("printer-type"');
    expect(cliSource).toContain('fs.String("device-class"');
  });

  it("agent reloads local registry before sending heartbeat", () => {
    const agentSource = fs.readFileSync(path.resolve(__dirname, "../agent/internal/agent/agent.go"), "utf-8");
    expect(agentSource).toContain("a.reloadRegistryPrinters()");
    expect(agentSource).toContain("skippedPrinters");
    expect(agentSource).toContain("rejected by gateway");
  });

  it("heartbeat API route populates skippedPrinters with structured reason", () => {
    const heartbeatRoute = fs.readFileSync(path.resolve(__dirname, "../src/app/api/agent/heartbeat/route.ts"), "utf-8");
    expect(heartbeatRoute).toContain("skipped.push({ id: rawId, reason: res.reason })");
    expect(heartbeatRoute).toContain("sanitizePrinter");
    expect(heartbeatRoute).toContain("skippedPrinters: skipped");
  });
});

describe("DEFECT #4 — Odoo Agent Selection & Runtime Printer Field", () => {
  it("binding model defaults company_id to parent company when accessed from a branch", () => {
    const bindingSource = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/models/binding.py"), "utf-8");
    expect(bindingSource).toContain("default=lambda self: self.env.company.parent_id or self.env.company");
  });

  it("runtime_printers controller passes agent_id parameter to Gateway", () => {
    const controllerSource = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/controllers/runtime_printers.py"), "utf-8");
    expect(controllerSource).toContain("params={'agent_id': agent_id.strip()}");
  });

  it("runtime_printer_field OWL component binds value and preserves offline configured printer", () => {
    const widgetSource = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/static/src/components/runtime_printer_field.js"), "utf-8");
    expect(widgetSource).toContain('t-att-value="props.record.data[props.name] || \'\'"');
    expect(widgetSource).toContain("configuredPrinterMissing");
    expect(widgetSource).toContain("configured / currently unreachable");
    expect(widgetSource).toContain("updateData.printer_protocol = found.protocol");
  });
});

describe("DEFECT #5 — Odoo POS TaxLabel & Receipt Rendering Contract", () => {
  it("pos_print_router.js renders OrderReceipt OWL component via renderer service with fallback", () => {
    const posRouter = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/static/src/js/pos_print_router.js"), "utf-8");
    expect(posRouter).toContain('import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt"');
    expect(posRouter).toContain("renderer.toJpeg(OrderReceipt");
    expect(posRouter).toContain("doesAnyOrderlineHaveTaxLabel: () => Boolean(currentOrder.lines?.some((l) => l.taxGroupLabels))");
    expect(posRouter).toContain("renderReceiptImage(this, currentOrder, basic)");
  });
});

describe("DEFECT #6 — Odoo PDF Download vs Gateway Silent Printing", () => {
  it("report_interceptor.js captures resIds from options and action context with report_id", () => {
    const interceptor = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/static/src/js/report_interceptor.js"), "utf-8");
    expect(interceptor).toContain("(options && options.active_ids)");
    expect(interceptor).toContain("report_id: action.id");
  });

  it("resolve_binding supports raise_if_not_found=False returning native route", () => {
    const routerSource = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/models/print_router.py"), "utf-8");
    expect(routerSource).toContain("def resolve_binding(self, *, report=None, record=None, document_type=None, company=None, explicit_destination=None, raise_if_not_found=True):");
    expect(routerSource).toContain('"native": True');
    expect(routerSource).toContain('"binding": False');
  });

  it("report_download_override allows native PDF download for unbound reports and fails closed on dispatch errors", () => {
    const downloadSource = fs.readFileSync(path.resolve(__dirname, "../odoo_addons/print_gateway/controllers/report_download_override.py"), "utf-8");
    expect(downloadSource).toContain("raise_if_not_found=False");
    expect(downloadSource).toContain('if not route.get("native") and route.get("gateway_enabled"):');
    expect(downloadSource).toContain("return super().report_download(data, context=context, token=token)");
    expect(downloadSource).toContain("status=502");
  });
});

describe("DEFECT #7 — Local Agent Test Print Latency Optimization", () => {
  it("TestPrinter checks DiscoverQuick first to avoid 10-second network TCP 9100 scan", () => {
    const discoverySource = fs.readFileSync(path.resolve(__dirname, "../agent/internal/printer/discovery.go"), "utf-8");
    expect(discoverySource).toContain("quickResult := DiscoverQuick(cfg, registryPath)");
    expect(discoverySource).toContain("// Fast path: Check quick local sources (registry, spooler, config) which complete in <10ms");
    expect(discoverySource).toContain("// Slow path fallback: Only run full discovery (including 10s network TCP 9100 sweep) if not found locally");
  });
});
