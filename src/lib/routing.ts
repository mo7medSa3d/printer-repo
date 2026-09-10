import { isVirtualPrinterRecord, type PrinterLike } from "./printer-virtual";
import { getAgentAvailability } from "./agent-availability";

export type CapabilityCheckResult = { ok: true } | { ok: false; reason: string };

export interface PayloadSpec {
  type: string;
  protocol?: string | null;
}

const BYTE_PROTOCOLS = ["raw", "escpos", "zpl", "tspl"] as const;

/**
 * Canonical payload/protocol → printer-capability table. This is the ONE
 * authoritative definition on the gateway side; the Go agent mirrors it
 * exactly in agent/internal/printer/capability.go, and both sides must be
 * changed together.
 *
 * Precedence rules:
 *  - An explicit `capabilities.supported_protocols` list is AUTHORITATIVE:
 *    a device either declares the payload's protocol/capability or it does
 *    not. There is no wildcard and no protocol inference from absence.
 *  - Without an explicit list, the device's declared transport protocol
 *    decides (escpos/zpl/tspl/raw byte sinks; spooler/ipp/ipps document
 *    transports; escpos devices additionally raster-convert JPEGs).
 *  - A raw payload with NO protocol is invalid input and never becomes
 *    "generic compatible" by default — the contract requires explicitness.
 */
export function validatePayloadForPrinter(
  payloadInput: PayloadSpec | null | undefined,
  printer: {
    protocol?: string | null;
    capabilities?: { supported_protocols?: string[] } | null;
    connectionType?: string | null;
    printerType?: string | null;
  },
): CapabilityCheckResult {
  if (!payloadInput) return { ok: true };
  const pt = (payloadInput.type ?? "").toLowerCase();
  const payloadProto = payloadInput.protocol ? payloadInput.protocol.toLowerCase() : null;
  const proto = (printer.protocol ?? "").toLowerCase();
  const conn = (printer.connectionType ?? "").toLowerCase();
  // Defensive coercion: the capabilities blob comes from agent-reported JSON
  // (validated only as "object" at ingestion). A non-array
  // supported_protocols used to throw TypeError here and 500 every job
  // creation for the printer. Treat it as absent (declared transport
  // decides) instead of crashing; the heartbeat sanitize additionally
  // bounds array contents to the known vocabulary.
  const rawSupported = printer.capabilities?.supported_protocols;
  const supported = Array.isArray(rawSupported)
    ? rawSupported.map((value) => String(value).toLowerCase())
    : undefined;
  const hasExplicitCaps = Array.isArray(supported) && supported.length > 0;
  // AUTHORITATIVE RULE for "unknown" protocol (mirrored in
  // agent/internal/printer/capability.go and documented in ARCHITECTURE.md):
  // "unknown" means "no byte language declared". The connection type is
  // itself an explicit TRANSPORT declaration for transports that are
  // physically complete (a Windows spooler queue renders documents; an IPP
  // URL accepts document formats), so unknown+spooler/ipp behaves as that
  // transport. For network/usb (byte pipes with no declared language) the
  // family resolves to a name nothing matches: invented-but-routable is
  // impossible, the device is inventoried but dark until declared.
  const family = proto && proto !== "unknown" ? proto : conn;
  const anyCap = (...names: string[]) => hasExplicitCaps
    ? names.some((name) => supported!.includes(name))
    : false;
  const transport = (...names: string[]) => !hasExplicitCaps && names.includes(family);

  // PDF: requires a transport that can actually consume/render a document.
  if (pt === "pdf") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: pdf payloads cannot specify a printer protocol" };
    }
    if (anyCap("pdf", "spooler", "ipp", "ipps") || transport("spooler", "ipp", "ipps")) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: pdf requires spooler or IPP transport" };
  }

  // Image: rendered by a driver-backed transport, or raster-converted by an
  // explicitly ESC/POS-capable device.
  if (pt === "image") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: image payloads cannot specify a printer protocol" };
    }
    if (anyCap("image", "jpeg", "spooler", "ipp", "ipps", "escpos") || transport("spooler", "escpos")) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
  }

  // ESC/POS payload types must declare the escpos protocol — explicitly.
  if (pt === "escpos") {
    if (payloadProto && payloadProto !== "escpos") {
      return { ok: false, reason: `CAPABILITY_MISMATCH: escpos payload cannot use protocol ${payloadProto}` };
    }
    if (anyCap("escpos") || transport("escpos")) return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not explicitly support ESC/POS (protocol=${proto || "unknown"})` };
  }

  // RAW byte streams require an EXPLICIT protocol; there is no default and no
  // wildcard. The device must declare that same protocol explicitly.
  if (pt === "raw") {
    if (!payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: raw payloads must declare an explicit protocol (raw, escpos, zpl, or tspl)" };
    }
    if (!(BYTE_PROTOCOLS as readonly string[]).includes(payloadProto)) {
      return { ok: false, reason: `CAPABILITY_MISMATCH: unsupported raw protocol ${payloadProto}` };
    }
    // raw+escpos is exactly an escpos payload; every other byte protocol is
    // accepted only by devices that declare it.
    if (anyCap(payloadProto) || transport(payloadProto)) return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not explicitly support ${payloadProto.toUpperCase()} (protocol=${proto || "unknown"})` };
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
