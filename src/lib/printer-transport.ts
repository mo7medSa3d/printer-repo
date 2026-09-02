/**
 * The canonical printer transport model.
 *
 * There are exactly THREE orthogonal fields describing a printer. Every part of
 * the gateway reads these and only these:
 *
 *   printerType     WHAT the device is        thermal | laser | inkjet |
 *                                             spooler | other | unknown
 *   connectionType  HOW we reach it           tcp | usb | spooler | ipp |
 *                   (the transport)           ipps | network
 *   protocol        WHAT BYTES it speaks      raw | escpos | ipp | ipps |
 *                                             spooler | windows_spooler
 *
 * They are orthogonal on purpose. "A laser printer, reached over IPP, that
 * accepts PDF" and "a thermal printer, reached over raw TCP, that accepts
 * ESC/POS" are both expressible with no field encoding another field's meaning.
 *
 * ---------------------------------------------------------------------------
 * The legacy `type` column
 * ---------------------------------------------------------------------------
 * `printers.type` predates this model and conflated device kind with transport
 * ("network", "usb", "spooler"). It is RETAINED as read-only compatibility data
 * for one reason: deployed Go agents still send it, and dropping it now would
 * break them mid-upgrade.
 *
 * The compatibility rules are absolute:
 *
 *   1. `type` is DERIVED from `connectionType`, never the reverse, and only by
 *      `canonicalTypeFor()` below.
 *   2. That derivation happens at exactly ONE boundary — `normalizePrinter()`
 *      in the agent heartbeat route — where inbound legacy payloads are
 *      converted into the canonical model immediately.
 *   3. No gateway logic branches on `type`. Routing, capability matching and
 *      virtual classification read the canonical fields only.
 *   4. `type` is written for backwards compatibility and otherwise ignored.
 *
 * Treat it as an output. Reading it to make a decision reintroduces exactly the
 * ambiguity this model removed.
 *
 * Removal path: bump the agent protocol version, wait out the support window
 * for agents that still send `type`, then drop the column in a new migration.
 * See docs/DATABASE.md, "Legacy printer fields".
 */

/** What the device physically is. */
export const PRINTER_TYPES = ["thermal", "laser", "inkjet", "spooler", "other", "unknown"] as const;
export type PrinterType = (typeof PRINTER_TYPES)[number];

/** How the gateway/agent reaches the device. */
export const CONNECTION_TYPES = ["tcp", "usb", "spooler", "ipp", "ipps", "network"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/** The byte language the device accepts. */
export const PRINTER_PROTOCOLS = ["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"] as const;
export type PrinterProtocol = (typeof PRINTER_PROTOCOLS)[number];

/** The canonical description of a printer's transport. */
export interface PrinterTransport {
  printerType: PrinterType;
  connectionType: ConnectionType;
  protocol: PrinterProtocol;
}

export function isPrinterType(v: unknown): v is PrinterType {
  return typeof v === "string" && (PRINTER_TYPES as readonly string[]).includes(v);
}

export function isConnectionType(v: unknown): v is ConnectionType {
  return typeof v === "string" && (CONNECTION_TYPES as readonly string[]).includes(v);
}

export function isPrinterProtocol(v: unknown): v is PrinterProtocol {
  return typeof v === "string" && (PRINTER_PROTOCOLS as readonly string[]).includes(v);
}

/**
 * Compute the legacy `type` value for a printer from its canonical transport.
 *
 * This is the ONLY supported way to produce `printers.type`. It exists so the
 * legacy column stays consistent with the canonical fields automatically,
 * rather than being set independently and drifting.
 *
 * The mapping is deliberately lossy in one direction only: several connection
 * types collapse onto "network", which is exactly why `type` cannot be used to
 * recover the transport and must not be read.
 */
export function canonicalTypeFor(connectionType: ConnectionType | string): string {
  switch (connectionType) {
    case "usb":
      return "usb";
    case "spooler":
      return "spooler";
    case "ipp":
      return "ipp";
    case "ipps":
      return "ipps";
    case "tcp":
      return "tcp";
    case "network":
      return "network";
    default:
      // Unknown transports are recorded as "network": the legacy vocabulary has
      // no better answer, and nothing reads this value to make a decision.
      return "network";
  }
}
