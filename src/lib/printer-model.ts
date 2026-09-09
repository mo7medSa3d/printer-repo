import { z } from "zod";

export const PRINTER_TYPES = ["physical", "virtual", "redirected"] as const;
export const DEVICE_CLASSES = ["thermal", "laser", "inkjet", "label", "other", "unknown"] as const;
export const CONNECTION_TYPES = ["network", "usb", "spooler", "ipp", "ipps"] as const;
// "unknown" means "not declared": the capability model never routes to it.
export const PRINTER_PROTOCOLS = ["raw", "escpos", "zpl", "tspl", "ipp", "ipps", "spooler", "unknown"] as const;

export const printerInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).max(120).optional(),
  agentId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(100),
  printerType: z.enum(PRINTER_TYPES).default("physical"),
  deviceClass: z.enum(DEVICE_CLASSES).default("unknown"),
  connectionType: z.enum(CONNECTION_TYPES).default("network"),
  protocol: z.enum(PRINTER_PROTOCOLS),
  config: z.object({
    ip: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    vid: z.number().int().min(0).max(65535).optional(),
    pid: z.number().int().min(0).max(65535).optional(),
    serial: z.string().max(255).optional(),
    address: z.string().max(512).optional(),
    spooler_name: z.string().max(255).optional(),
    paper_widths: z.array(z.number().finite().positive().max(1000)).max(32).optional(),
    color_capable: z.boolean().optional(),
    duplex_capable: z.boolean().optional(),
  }).strict().default({}),
  capabilities: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type CanonicalPrinterInput = z.infer<typeof printerInputSchema>;
export const PRINTER_CONFIG_MAX_BYTES = 16 * 1024;
export const PRINTER_CAPABILITIES_MAX_BYTES = 32 * 1024;

export function assertPrinterMetadataLimits(input: Pick<CanonicalPrinterInput, "config" | "capabilities">): void {
  if (JSON.stringify(input.config ?? {}).length > PRINTER_CONFIG_MAX_BYTES) throw new Error("printer config exceeds 16KB");
  if (input.capabilities && JSON.stringify(input.capabilities).length > PRINTER_CAPABILITIES_MAX_BYTES) throw new Error("printer capabilities exceed 32KB");
}

/**
 * Connection-transport sanity shared by the manager create route AND the
 * agent heartbeat upsert: a network printer without ip/port is unroutable
 * garbage, not a half-registered device. One rule, both boundaries.
 */
export function validateConnectionConfig(connectionType: string, cfg: Record<string, unknown>): string | null {
  if (connectionType === "network") {
    if (!cfg.ip || typeof cfg.ip !== "string") return "network printer requires config.ip";
    if (!cfg.port || typeof cfg.port !== "number") return "network printer requires config.port";
    if (cfg.ip.includes(" ")) return "invalid network address";
  }
  if (connectionType === "spooler" && !(typeof cfg.spooler_name === "string" && cfg.spooler_name.trim()) && !(typeof cfg.address === "string" && cfg.address.trim())) {
    return "spooler printer requires config.spooler_name or config.address";
  }
  return null;
}

export function parsePrinterInput(value: unknown): CanonicalPrinterInput {
  const parsed = printerInputSchema.parse(value);
  assertPrinterMetadataLimits(parsed);
  return parsed;
}
