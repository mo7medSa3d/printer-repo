import { z } from "zod";

// Mirrors agent/internal/payload/payload.go exactly - the two must be
// kept in sync. See API.md for the documented wire format.
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB — mirrors agent/internal/payload/payload.go

/**
 * A PDF file always starts with the 5-byte signature `%PDF-`.
 *
 * This matters because PDF and RAW are not interchangeable: RAW means "bytes
 * that are already in the printer's own command language". If a PDF byte
 * stream is declared as `raw`, an ESC/POS or RAW-spooler transport will happily
 * send it to the device, which prints dozens of pages of PDF source text
 * instead of the document. The failure is silent, wastes an entire paper roll,
 * and looks like a printer fault rather than a mapping bug.
 *
 * So a payload's declared type must match its actual content.
 */
export const PDF_MAGIC = "%PDF-";

/** True when these bytes are a PDF document, regardless of what they claim. */
export function looksLikePdf(bytes: Buffer): boolean {
  // Some producers emit leading whitespace/BOM before the header; the PDF spec
  // requires %PDF- within the first 1024 bytes for a file to be readable.
  const head = bytes.subarray(0, 1024).toString("latin1");
  return head.includes(PDF_MAGIC);
}

export const printJobPayloadSchema = z.object({
  type: z.enum(["raw", "escpos", "pdf"]),
  encoding: z.literal("base64"),
  data: z.string().min(1).refine((s) => {
    // cheap base64 length check before decode: 4/3 expansion
    if (s.length > (MAX_PAYLOAD_BYTES / 3) * 4 + 8) return false;
    try {
      const decoded = Buffer.from(s, "base64");
      if (decoded.length === 0) return false;
      if (decoded.length > MAX_PAYLOAD_BYTES) return false;
      // Round-trip check: Buffer.from silently tolerates invalid base64
      // (skips non-alphabet chars, accepts missing padding), while the Go
      // agent's base64.StdEncoding.DecodeString is strict. Canonical
      // re-encoding keeps the gateway's validator in lockstep with the
      // agent's, so a job we accept can never be rejected downstream.
      if (decoded.toString("base64") !== s) return false;
      return true;
    } catch {
      return false;
    }
  }, { message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` }),
}).superRefine((payload, ctx) => {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload.data, "base64");
  } catch {
    return; // the field-level refine above already reported this
  }
  const isPdf = looksLikePdf(bytes);

  // PDF bytes must never masquerade as a printer byte-stream.
  if (isPdf && payload.type !== "pdf") {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message:
        `payload declares type "${payload.type}" but the data is a PDF document (starts with ${PDF_MAGIC}). ` +
        `PDF bytes are not ${payload.type} bytes: sending them to a ${payload.type} transport prints the PDF source, not the document. ` +
        `Either set type "pdf" and route to a printer that declares PDF support, or render the document to real ${payload.type} bytes first.`,
    });
    return;
  }

  // ...and the converse: a job claiming to be a PDF that is not one would be
  // handed to a PDF rendering path that cannot parse it.
  if (!isPdf && payload.type === "pdf") {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: `payload declares type "pdf" but the data is not a PDF document (missing ${PDF_MAGIC} header)`,
    });
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
