import { isVirtualPrinterRecord, type PrinterLike } from "./printer-virtual";
import { getAgentAvailability } from "./agent-availability";

export type CapabilityCheckResult = { ok: true } | { ok: false; reason: string };

export interface PayloadSpec {
  type: string;
  protocol?: string | null;
}

export function validatePayloadForPrinter(
  payloadInput: PayloadSpec | string | null | undefined,
  printer: {
    protocol?: string | null;
    capabilities?: { supported_protocols?: string[] } | null;
    connectionType?: string | null;
    printerType?: string | null;
  },
): CapabilityCheckResult {
  if (!payloadInput) return { ok: true };
  const pt = (typeof payloadInput === "string" ? payloadInput : payloadInput.type).toLowerCase();
  const payloadProto = typeof payloadInput === "object" && payloadInput?.protocol ? payloadInput.protocol.toLowerCase() : null;
  const proto = (printer.protocol ?? "").toLowerCase();
  const conn = (printer.connectionType ?? "").toLowerCase();
  const supported = printer.capabilities?.supported_protocols?.map((value) => value.toLowerCase());

  // PDF
  if (pt === "pdf") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: pdf payloads cannot specify a printer protocol" };
    }
    const canSpool = proto === "spooler" || conn === "spooler";
    const canIpp = ["ipp", "ipps"].includes(proto) || ["ipp", "ipps"].includes(conn);
    const explicitlySupported = supported?.includes("pdf") || supported?.includes("spooler") || supported?.includes("ipp");
    if (canSpool || canIpp || explicitlySupported) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: pdf requires spooler or IPP transport" };
  }

  // Image
  if (pt === "image") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: image payloads cannot specify a printer protocol" };
    }
    const canSpool = proto === "spooler" || conn === "spooler";
    const explicitlySupported = supported?.includes("image") || supported?.includes("jpeg") || supported?.includes("spooler");
    if (canSpool || explicitlySupported) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
  }

  // ESC/POS
  if (pt === "escpos") {
    if (payloadProto && payloadProto !== "escpos") {
      return { ok: false, reason: `CAPABILITY_MISMATCH: escpos payload cannot use protocol ${payloadProto}` };
    }
    if (supported?.length) {
      if (supported.includes("escpos") || supported.includes("spooler") || supported.includes("raw")) return { ok: true };
      return { ok: false, reason: "CAPABILITY_MISMATCH: printer capabilities do not support escpos" };
    }
    return ["escpos", "raw", "spooler"].includes(proto) || conn === "spooler"
      ? { ok: true }
      : { ok: false, reason: `CAPABILITY_MISMATCH: escpos incompatible with printer protocol ${proto}` };
  }

  // RAW
  if (pt === "raw") {
    const targetProto = payloadProto || "raw";
    if (targetProto === "zpl" || targetProto === "tspl") {
      if (supported?.length) {
        if (supported.includes(targetProto)) return { ok: true };
        return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not support ${targetProto.toUpperCase()}` };
      }
      return proto === targetProto
        ? { ok: true }
        : { ok: false, reason: `CAPABILITY_MISMATCH: printer protocol ${proto} does not match required ${targetProto.toUpperCase()}` };
    }
    if (targetProto === "escpos") {
      if (supported?.length) {
        if (supported.includes("escpos") || supported.includes("spooler") || supported.includes("raw")) return { ok: true };
        return { ok: false, reason: "CAPABILITY_MISMATCH: printer does not support ESC/POS" };
      }
      return ["escpos", "raw", "spooler"].includes(proto) || conn === "spooler"
        ? { ok: true }
        : { ok: false, reason: `CAPABILITY_MISMATCH: raw escpos incompatible with printer protocol ${proto}` };
    }
    // Generic RAW
    if (supported?.length) {
      if (supported.includes("raw") || supported.includes("spooler")) return { ok: true };
      return { ok: false, reason: "CAPABILITY_MISMATCH: printer does not support raw payload" };
    }
    return ["raw", "spooler"].includes(proto) || conn === "spooler"
      ? { ok: true }
      : { ok: false, reason: `CAPABILITY_MISMATCH: raw incompatible with printer protocol ${proto}` };
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
