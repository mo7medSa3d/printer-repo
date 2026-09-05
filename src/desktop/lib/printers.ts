import type { PrinterInfo } from "./ipc";
import type { Tone } from "../../components/ui";
import { isVirtualPrinterRecord } from "../../lib/printer-virtual";

/* ============================================================
   Desktop presentation helpers for printers
   ------------------------------------------------------------
   Status vocabulary (icon + colour + label) lives here so every
   page renders the same status the same way.
   ============================================================ */

/* ---------- Virtual / software printer safety net ---------- */
/**
 * DEFENSIVE FILTER ONLY.
 *
 * The authoritative filter runs in the Windows agent: virtual, software and
 * RDP-redirected printers are classified during discovery (port monitor,
 * driver, PnP ids, transport) and never reach the registry, the heartbeat or
 * the Gateway. This helper is the last line of defence so an old record
 * (persisted by a previous version) or a manual registration can never be
 * rendered as a production printer.
 *
 * It shares the Gateway's single classification rule, so it reads the same
 * normalized metadata (and the same port-monitor table) instead of relying on
 * the printer name alone.
 */
export function isVirtualPrinter(p: PrinterInfo | null | undefined): boolean {
  if (!p) return false;
  const anyP = p as unknown as Record<string, unknown>;
  if (anyP.isVirtual === true || anyP.is_virtual === true) return true;
  return isVirtualPrinterRecord({
    name: p.name,
    printerType: p.printer_type,
    connectionType: p.connection_type,
    protocol: p.protocol,
    capabilities: p.capabilities,
  });
}

/** Printers that may be shown, selected for a binding and used for jobs. */
export function isProductionPrinter(p: PrinterInfo): boolean {
  return !isVirtualPrinter(p);
}

/* ---------- Status vocabulary ---------- */

export function printerTone(status: string): Tone {
  switch (status) {
    case "online":
      return "ok";
    case "busy":
      return "warn";
    case "error":
    case "offline":
      return "bad";
    default:
      return "neutral";
  }
}

export function jobTone(status: string): Tone {
  switch (status) {
    case "success":
    case "completed":
      return "ok";
    case "failed":
    case "expired":
      return "bad";
    case "printing":
      return "warn";
    case "claimed":
      return "info";
    case "queued":
      return "neutral";
    default:
      return "neutral";
  }
}

export function labelPrinter(status: string): string {
  return status === "unknown"
    ? "Unknown"
    : status.charAt(0).toUpperCase() + status.slice(1);
}

export function labelJob(status: string): string {
  if (status === "success" || status === "completed") return "Completed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ---------- Human-friendly descriptions ---------- */

export function humanType(p: PrinterInfo): string {
  const t = (p.printer_type || "").toLowerCase();
  if (t === "thermal" || t === "label") return "Thermal";
  if (t === "laser") return "Laser";
  if (t === "inkjet") return "Inkjet";
  if ((p.connection_type || "").toLowerCase() === "usb") return "USB device";
  if (t && t !== "unknown") return t.charAt(0).toUpperCase() + t.slice(1);
  return "Printer";
}

export function humanConnection(p: PrinterInfo): string {
  const c = (p.connection_type || p.printer_type || "").toLowerCase();
  const proto = (p.protocol || "").toLowerCase();
  if (c === "spooler" || proto === "spooler") return "Windows spooler";
  if (c === "usb") return "USB";
  if (c === "ipp" || c === "ipps" || proto === "ipp" || proto === "ipps") return "IPP";
  if (c === "network" || c === "tcp") return "Network (TCP)";
  return "Printer";
}

export function printerEndpoint(p: PrinterInfo): string {
  if (p.network_address) return `${p.network_address}${p.port ? `:${p.port}` : ""}`;
  if (p.endpoint) return p.endpoint;
  return p.spooler_name || "—";
}

/* ---------- Errors ---------- */

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function friendlyPrinterError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("connection refused") || lower.includes("dial tcp"))
    return "Could not connect to the printer.";
  if (lower.includes("timeout") || lower.includes("deadline"))
    return "Printer did not respond in time.";
  if (lower.includes("offline")) return "Printer is offline.";
  if (lower.includes("not found") || lower.includes("no such"))
    return "Printer not found.";
  if (lower.includes("access denied") || lower.includes("permission"))
    return "Access denied. Check Windows printer permissions.";
  return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
}

/* ---------- Job field accessors (gateway payloads are loosely typed) ---------- */

export function jobId(j: Record<string, unknown>): string {
  return String(j.id ?? j.jobId ?? "");
}
export function jobDocType(j: Record<string, unknown>): string {
  return String(j.documentType ?? j.document_type ?? "Document");
}
export function jobPrinterId(j: Record<string, unknown>): string {
  return String(j.printerId ?? "");
}
export function jobStatus(j: Record<string, unknown>): string {
  return String(j.status ?? "");
}
