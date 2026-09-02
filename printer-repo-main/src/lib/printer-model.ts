import { z } from "zod";

export const PRINTER_TYPES = ["physical", "virtual", "redirected"] as const;
export const DEVICE_CLASSES = ["thermal", "laser", "inkjet", "label", "other", "unknown"] as const;
export const CONNECTION_TYPES = ["network", "usb", "spooler", "ipp", "ipps"] as const;
export const PRINTER_PROTOCOLS = ["raw", "escpos", "ipp", "ipps", "spooler"] as const;

export const printerInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9_][a-z0-9_-]*$/).max(120).optional(),
  agentId: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(100),
  printerType: z.enum(PRINTER_TYPES).default("physical"),
  deviceClass: z.enum(DEVICE_CLASSES).default("unknown"),
  connectionType: z.enum(CONNECTION_TYPES).default("network"),
  protocol: z.enum(PRINTER_PROTOCOLS).default("raw"),
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
  if (JSON.stringify(input.config ?? {}).length > PRINTER_CONFIG_MAX_BYTES) {
    throw new Error("printer config exceeds 16KB");
  }
  if (input.capabilities && JSON.stringify(input.capabilities).length > PRINTER_CAPABILITIES_MAX_BYTES) {
    throw new Error("printer capabilities exceed 32KB");
  }
}

export function normalizeLegacyPrinterInput(value: unknown): CanonicalPrinterInput {
  const input = (value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if ("branchId" in input || "branch_id" in input || "enabled" in input) {
    throw new z.ZodError([{ code: "custom", path: [], message: "branchId/branch_id/enabled are not writable printer ownership fields" }]);
  }
  // Legacy clients used printerType for hardware class. Normalize that alias
  // once at the input boundary instead of persisting two writable meanings.
  const legacyPrinterType = typeof input.printerType === "string" ? input.printerType.toLowerCase().trim() : "";
  if (legacyPrinterType && !PRINTER_TYPES.includes(legacyPrinterType as any) && DEVICE_CLASSES.includes(legacyPrinterType as any)) {
    if (input.deviceClass === undefined) input.deviceClass = legacyPrinterType;
    input.printerType = "physical";
  }

  const legacyConnection = typeof input.type === "string" ? input.type.toLowerCase().trim() : undefined;
  const normalizedLegacyConnection = legacyConnection === "tcp" ? "network" : legacyConnection === "windows_spooler" ? "spooler" : legacyConnection;
  if (normalizedLegacyConnection && input.connectionType !== undefined && input.connectionType !== normalizedLegacyConnection) {
    throw new z.ZodError([{ code: "custom", path: ["connectionType"], message: "conflicting legacy type and canonical connectionType" }]);
  }
  if (input.connectionType === undefined && normalizedLegacyConnection) input.connectionType = normalizedLegacyConnection;
  const cfg = input.config && typeof input.config === "object" ? { ...(input.config as Record<string, unknown>) } : {};
  const legacyProtocol = typeof cfg.protocol === "string" ? (cfg.protocol === "windows_spooler" ? "spooler" : cfg.protocol) : undefined;
  if (legacyProtocol && input.protocol !== undefined && input.protocol !== legacyProtocol) {
    throw new z.ZodError([{ code: "custom", path: ["protocol"], message: "conflicting legacy config.protocol and canonical protocol" }]);
  }
  if (input.protocol === undefined && legacyProtocol) input.protocol = legacyProtocol;
  delete input.type;
  delete cfg.protocol;
  input.config = cfg;
  const parsed = printerInputSchema.parse(input);
  assertPrinterMetadataLimits(parsed);
  return parsed;
}

