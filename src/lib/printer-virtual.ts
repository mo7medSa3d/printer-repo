/* ============================================================
   Virtual / software printer guard (Gateway side)
   ------------------------------------------------------------
   The authoritative filter runs in the Windows agent: virtual,
   software and RDP-redirected queues are classified during
   discovery and never reach the registry, the heartbeat or this
   Gateway.

   Deployments upgraded from an earlier version may still carry a
   virtual printer row. Such a row is NOT deleted (data is
   preserved) but it must never behave like a production route:

     - never selected by resolvePrinterForJob
     - never reported as available for a job
     - never accepted by the legacy printerId print path

   Detection reads normalized metadata first (printerType,
   connectionType, protocol, capabilities) and only falls back to
   well-known software-writer names when a row predates those
   fields — never a name-only blacklist as the primary signal.
   ============================================================ */

export interface PrinterLike {
  name?: string | null;
  printerType?: string | null;
  connectionType?: string | null;
  protocol?: string | null;
  capabilities?: unknown;
}

/** Capability keys that mark a queue as software-only. */
const VIRTUAL_CAPABILITY_KEYS = ["virtual", "is_virtual"] as const;
const VIRTUAL_CLASSES = new Set(["virtual", "redirected"]);

/**
 * Windows port monitors whose output never reaches hardware: they write a
 * file, discard the job or dial a modem. Same authority as the agent's
 * classifier — a port monitor is device metadata, not a printer name.
 */
const VIRTUAL_PORT_MONITORS = [
  "portprompt:", // Microsoft Print to PDF / print-to-file prompt
  "xpsport:", // Microsoft XPS Document Writer
  "file:", // print to file
  "nul:",
  "null:",
  "shrfax:", // Windows Shared Fax
  "fax:",
];

function isVirtualPortMonitor(port: unknown): boolean {
  const raw = lower(port);
  if (!raw) return false;
  // "IP_192.168.1.50,SNMP" → "ip_192.168.1.50"
  const head = raw.split(",")[0].trim();
  return VIRTUAL_PORT_MONITORS.some((monitor) => head === monitor || head.startsWith(monitor));
}

/**
 * Software-writer / session-redirect name families. Used ONLY as a fallback
 * for legacy rows that carry no metadata — the agent's classifier is the
 * primary authority and works from port monitors, drivers and PnP ids.
 */
const VIRTUAL_NAME_PATTERNS = [
  "microsoft print to pdf",
  "microsoft xps document writer",
  "microsoft shared fax",
  "microsoft enhanced point and print compatibility driver",
  "send to onenote",
  "onenote",
  "document writer",
  "print to pdf",
  "pdf writer",
  "pdf creator",
  "pdf converter",
  "virtual printer",
  "software printer",
  "remote desktop easy print",
  "terminal services easy print",
];

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function capabilitiesRecord(capabilities: unknown): Record<string, unknown> | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  return capabilities as Record<string, unknown>;
}

/**
 * True when the printer record describes a virtual, software or
 * session-redirected queue rather than real printing hardware.
 */
export function isVirtualPrinterRecord(printer: PrinterLike | null | undefined): boolean {
  if (!printer) return false;

  const type = lower(printer.printerType);
  const connection = lower(printer.connectionType);
  const protocol = lower(printer.protocol);
  if (type === "virtual" || connection === "virtual" || protocol === "virtual") return true;

  const caps = capabilitiesRecord(printer.capabilities);
  if (caps) {
    for (const key of VIRTUAL_CAPABILITY_KEYS) {
      if (caps[key] === true || lower(caps[key]) === "true") return true;
    }
    const klass = lower(caps.printer_class ?? caps["printerClass"]);
    if (VIRTUAL_CLASSES.has(klass)) return true;
    if (isVirtualPortMonitor(caps.port_name ?? caps["portName"])) return true;
  }

  // Legacy fallback: a row persisted before the metadata existed.
  const name = lower(printer.name);
  if (!name) return false;
  if (name.includes("(redirected")) return true;
  return VIRTUAL_NAME_PATTERNS.some((pattern) => name.includes(pattern));
}

/** A printer row that may be routed to, bound and used for jobs. */
export function isRoutablePrinterRecord(printer: PrinterLike | null | undefined): boolean {
  return !isVirtualPrinterRecord(printer);
}
