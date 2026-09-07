import { isVirtualPrinterRecord, type PrinterLike } from "./printer-virtual";
import { getAgentAvailability } from "./agent-availability";

export type CapabilityCheckResult = { ok: true } | { ok: false; reason: string };

export function validatePayloadForPrinter(
  payloadType: string | null | undefined,
  printer: {
    protocol?: string | null;
    capabilities?: { supported_protocols?: string[] } | null;
    connectionType?: string | null;
    printerType?: string | null;
  },
): CapabilityCheckResult {
  if (!payloadType) return { ok: true };
  const pt = payloadType.toLowerCase();
  const proto = (printer.protocol ?? "").toLowerCase();
  const conn = (printer.connectionType ?? "").toLowerCase();
  const supported = printer.capabilities?.supported_protocols?.map((value) => value.toLowerCase());

  if (supported?.length) {
    if (supported.includes(pt)) return { ok: true };
    if ((pt === "raw" || pt === "escpos") && (supported.includes("raw") || supported.includes("escpos") || conn === "spooler" || proto === "spooler")) return { ok: true };
    // The Agent converts JPEG (POS/Kitchen) to PDF or ESC/POS raster when the
    // backend does not natively accept image/jpeg.
    if (pt === "image" && (supported.includes("pdf") || supported.includes("raw") || supported.includes("escpos") || supported.includes("image"))) {
      return { ok: true };
    }
    return { ok: false, reason: `CAPABILITY_MISMATCH: payload type ${pt} not supported by printer` };
  }
  if (["ipp", "ipps"].includes(proto) || ["ipp", "ipps"].includes(conn)) {
    return ["raw", "escpos", "pdf", "image"].includes(pt) ? { ok: true } : { ok: false, reason: `CAPABILITY_MISMATCH: payload ${pt} is not supported by IPP transport` };
  }
  if (pt === "raw" || pt === "escpos") {
    return ["raw", "escpos", "spooler", ""].includes(proto) || conn === "spooler"
      ? { ok: true }
      : { ok: false, reason: `CAPABILITY_MISMATCH: ${pt} incompatible with printer protocol ${proto}` };
  }
  if (pt === "pdf") {
    return proto === "spooler" || conn === "spooler"
      ? { ok: true }
      : { ok: false, reason: `CAPABILITY_MISMATCH: pdf requires spooler or IPP transport` };
  }
  if (pt === "image") {
    return proto === "spooler" || conn === "spooler" || conn === "network" || conn === "usb" || ["raw", "escpos", ""].includes(proto)
      ? { ok: true }
      : { ok: false, reason: `CAPABILITY_MISMATCH: unsupported payload type ${pt}` };
  }
  return { ok: false, reason: `CAPABILITY_MISMATCH: unsupported payload type ${pt}` };
}

export interface PrinterAvailability extends PrinterLike {
  lifecycle: string | null;
  status: string | null;
}

export function isPrinterAvailableForJob(printer: PrinterAvailability): boolean {
  if (printer.lifecycle !== "active") return false;
  if (isVirtualPrinterRecord(printer)) return false;
  return printer.status === "online";
}

export function isAgentAvailableForPrinter(agent: {
  lifecycle?: string | null;
  status?: string | null;
  lastSeenAt?: Date | string | null;
}) {
  if (agent.lifecycle !== "active") return false;
  return getAgentAvailability(agent).available;
}
