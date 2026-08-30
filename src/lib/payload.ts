import { z } from "zod";

// Mirrors agent/internal/payload/payload.go exactly - the two must be
// kept in sync. See API.md for the documented wire format.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB — mirrors agent/internal/payload/payload.go

export const printJobPayloadSchema = z.object({
  type: z.enum(["raw", "escpos"]),
  encoding: z.literal("base64"),
  data: z.string().min(1).refine((s) => {
    // cheap base64 length check before decode: 4/3 expansion
    if (s.length > (MAX_PAYLOAD_BYTES / 3) * 4 + 8) return false;
    try {
      const decoded = Buffer.from(s, "base64");
      // round-trip check guards invalid base64 accepted by Buffer.from
      if (decoded.length === 0) return false;
      if (decoded.length > MAX_PAYLOAD_BYTES) return false;
      return true;
    } catch {
      return false;
    }
  }, { message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` }),
});

export type PrintJobPayload = z.infer<typeof printJobPayloadSchema>;

export function validatePrintJobPayload(payload: unknown): PrintJobPayload {
  return printJobPayloadSchema.parse(payload);
}

/** Builds a small, valid ESC/POS test-print payload. */
export function buildTestPrintPayload(printerName: string, agentName: string): PrintJobPayload {
  const lines = [
    "\x1b\x40", // ESC/POS initialize
    "Odoo Print Agent\n",
    "Test Print\n",
    `Printer: ${printerName}\n`,
    `Agent: ${agentName}\n`,
    "------------------------\n",
    "Connection OK\n",
    "------------------------\n\n\n",
    "\x1d\x56\x01", // partial cut
  ].join("");

  return {
    type: "escpos",
    encoding: "base64",
    data: Buffer.from(lines, "binary").toString("base64"),
  };
}
