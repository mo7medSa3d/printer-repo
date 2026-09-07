import { z } from "zod";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export const printJobPayloadSchema = z.object({
  type: z.enum(["raw", "escpos", "pdf", "image"]),
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
  const pdfSignature = Buffer.from("%PDF-");
  const jpegSignature = decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
  const looksLikePdf = decoded.length >= pdfSignature.length && decoded.subarray(0, pdfSignature.length).equals(pdfSignature);

  if (payload.type === "pdf" && !looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload must start with the %PDF- signature" });
  }
  if (payload.type === "image" && !jpegSignature) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "Image payload must be a JPEG" });
  }
  if ((payload.type === "raw" || payload.type === "escpos") && looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF bytes cannot be labeled as raw/escpos; provide a real byte-stream payload or convert explicitly" });
  }
});

export type PrintJobPayload = z.infer<typeof printJobPayloadSchema>;

export function validatePrintJobPayload(payload: unknown): PrintJobPayload {
  return printJobPayloadSchema.parse(payload);
}

export function buildTestPrintPayload(printerName: string, agentName: string): PrintJobPayload {
  const lines = [
    "\x1b\x40",
    "Odoo Print Agent\n",
    "Test Print\n",
    `Printer: ${printerName}\n`,
    `Agent: ${agentName}\n`,
    "------------------------\n",
    "Connection OK\n",
    "------------------------\n\n\n",
    "\x1d\x56\x01",
  ].join("");

  return { type: "escpos", encoding: "base64", data: Buffer.from(lines, "binary").toString("base64") };
}