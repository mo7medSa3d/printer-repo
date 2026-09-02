import { z } from "zod";

// Mirrors agent/internal/payload/payload.go exactly - the two must be
// kept in sync. See API.md for the documented wire format.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB — mirrors agent/internal/payload/payload.go

export const printJobPayloadSchema = z.object({
  type: z.enum(["raw", "escpos", "pdf"]),
  encoding: z.literal("base64"),
  data: z.string().min(1).refine((value) => {
    if (value.length > (MAX_PAYLOAD_BYTES / 3) * 4 + 8) return false;
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length === 0 || decoded.length > MAX_PAYLOAD_BYTES) return false;
      return decoded.toString("base64") === value;
    } catch {
      return false;
    }
  }, { message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` }),
}).superRefine((payload, ctx) => {
  const decoded = Buffer.from(payload.data, "base64");
  const signature = Buffer.from("%PDF-");
  const looksLikePdf = decoded.length >= signature.length && decoded.subarray(0, signature.length).equals(signature);
  if (payload.type === "pdf" && !looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload must start with the %PDF- signature" });
  }
  if ((payload.type === "raw" || payload.type === "escpos") && looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF bytes cannot be labeled as raw/escpos; provide a real byte-stream payload or convert explicitly" });
  }
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
