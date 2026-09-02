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
 * Driver / PnP / name families that only ever produce a file or hand the job
 * to an application. Mirrors the Windows agent's `softwareWriterTokens`.
 *
 * These are matched against the driver name and PnP ids as well as the
 * printer name: a redirected or software queue is identified by its driver
 * far more reliably than by its display name.
 */
const SOFTWARE_WRITER_TOKENS = [
  // Microsoft in-box software writers
  "microsoft print to pdf",
  "microsoft xps document writer",
  "microsoft shared fax",
  "microsoft enhanced point and print compatibility driver",
  "send to onenote",
  "onenote",
  // Semantic families (language independent)
  "document writer",
  "documentwriter",
  "print to pdf",
  "topdf",
  "pdf writer",
  "pdfwriter",
  "pdf printer",
  "pdf creator",
  "pdf converter",
  "pdf architect",
  "virtual printer",
  "software printer",
  "image printer",
  // Widely deployed third-party software writers
  "foxit",
  "anydesk",
  "cutepdf",
  "pdf995",
  "novapdf",
  "bullzip",
  "pdfcreator",
  "pdfforge",
  "doro pdf",
  "biopdf",
  "nitro pdf",
  "adobe pdf",
  "bluebeam",
  "tinypdf",
  "7-pdf",
  "icecream pdf",
  "pdf24",
];

/**
 * Queues tunnelled from another desktop session: Remote Desktop, Citrix,
 * VMware, ThinPrint. Mirrors the agent's `sessionRedirectTokens`.
 */
const SESSION_REDIRECT_TOKENS = [
  "remote desktop easy print",
  "terminal services easy print",
  "ts easy print",
  "easy print",
  "citrix",
  "vmware virtual print",
  "thinprint",
  "safeguard print",
];

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Everything that identifies the device, lowercased, so one substring scan
 * covers the driver, the PnP ids and the comment — the same haystack the
 * Windows agent classifies from.
 */
function identityHaystack(caps: Record<string, unknown> | null): string {
  if (!caps) return "";
  const parts: string[] = [];
  for (const key of ["driver_name", "driverName", "comment", "device_id", "deviceId"]) {
    const value = lower(caps[key]);
    if (value) parts.push(value);
  }
  for (const key of ["hardware_ids", "hardwareIds", "compatible_ids", "compatibleIds"]) {
    const value = caps[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = lower(entry);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join(" ");
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

  // Session redirect: Remote Desktop / Citrix / VMware. Windows names these
  // "HP LaserJet (redirected 3)"; Citrix uses "… (from WKS12) in session 4".
  const name = lower(printer.name);
  if (name.includes("(redirected") || name.includes(" in session ")) return true;

  // The driver (and PnP ids) identify a software writer or a session tunnel
  // far more reliably than the display name does.
  const hay = identityHaystack(caps);
  if (hay) {
    if (SOFTWARE_WRITER_TOKENS.some((token) => hay.includes(token))) return true;
    if (SESSION_REDIRECT_TOKENS.some((token) => hay.includes(token))) return true;
  }

  // Legacy fallback: a row persisted before any metadata existed.
  if (!name) return false;
  return SOFTWARE_WRITER_TOKENS.some((pattern) => name.includes(pattern));
}

/** A printer row that may be routed to, bound and used for jobs. */
export function isRoutablePrinterRecord(printer: PrinterLike | null | undefined): boolean {
  return !isVirtualPrinterRecord(printer);
}
