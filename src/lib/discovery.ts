import { z } from "zod";

// Canonical discovery taxonomy — discovery sources, NOT printer protocols.
// Printer's canonical protocol remains PRINTER_PROTOCOLS (raw/escpos/ipp/ipps/spooler).
export const DISCOVERY_SOURCES = ["mdns","ipp","ipps","raw","lpr","snmp","wsd","windows_spooler","usb","unknown","subnet","config","registry"] as const;
export type DiscoverySource = typeof DISCOVERY_SOURCES[number];
export const DISCOVERY_PROTOCOLS = ["ipp","ipps","raw","lpr","mdns","snmp","wsd","windows_spooler","usb","unknown","escpos","spooler"] as const;
export const DISCOVERY_CONFIDENCE = ["low","medium","high"] as const;
export const DISCOVERY_VERIFICATION = ["candidate","verified"] as const;
export const DISCOVERY_CANDIDATE_STATUS = ["discovered","verified","provisioned","ignored","expired"] as const;
export const DISCOVERY_SESSION_STATUS = ["running","completed","partial","failed","cancelled"] as const;

export const discoveryStartSchema = z.object({
  cidr: z.string().optional(),
  protocols: z.array(z.enum(DISCOVERY_PROTOCOLS)).optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(500).max(30000).optional(),
}).strict();

export function isPrivateCIDR(cidr: string): boolean {
  // Mirrors Go isAllowedCIDR: private only, /16-/30
  const parts = cidr.split("/");
  if (parts.length !== 2) return false;
  const ip = parts[0];
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30) return false;
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isFinite(o) || o < 0 || o > 255)) return false;
  // 10/8, 172.16/12, 192.168/16
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  return false;
}

export function validateDiscoveryRequest(body: unknown): { ok: true; cidr?: string } | { ok: false; error: string } {
  const parsed = discoveryStartSchema.safeParse(body ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid discovery request" };
  if (parsed.data.cidr && !isPrivateCIDR(parsed.data.cidr)) {
    return { ok: false, error: "CIDR must be private (10/8, 172.16/12, 192.168/16) and /16-/30" };
  }
  return { ok: true, cidr: parsed.data.cidr };
}

export function confidenceFor(source: string[], verification: string, hasModel: boolean): string {
  const verified = verification === "verified";
  const count = source.length;
  const hasHigh = verified && (source.includes("ipp") || source.includes("ipps") || source.includes("windows_spooler"));
  if (hasHigh || (count >= 2 && hasModel)) return "high";
  if (verified || count >= 2 || hasModel) return "medium";
  return "low";
}
