import { z } from "zod";

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export const printJobPayloadSchema = z.object({
  type: z.enum(["raw", "escpos", "pdf", "image"]),
  encoding: z.literal("base64"),
  protocol: z.enum(["escpos", "zpl", "tspl", "raw"]).optional(),
  peripherals: z.object({
    drawer: z.enum(["pin2", "pin5", "none"]).optional(),
    cutter: z.enum(["partial", "full", "none"]).optional(),
    buzzer: z.enum(["epson_pulse", "star_bel", "none"]).optional(),
  }).optional(),
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

  if (payload.type === "raw") {
    if (!payload.protocol) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is required for raw payloads" });
    }
  }
  if (payload.type === "escpos") {
    if (!payload.protocol || payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol 'escpos' is required for escpos payloads" });
    }
  }
  if ((payload.type === "pdf" || payload.type === "image") && payload.protocol) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is not applicable for pdf/image payloads" });
  }
  if (payload.peripherals) {
    const hasPeripherals = [payload.peripherals.drawer, payload.peripherals.cutter, payload.peripherals.buzzer]
      .some((mode) => Boolean(mode) && mode !== "none");
    if (hasPeripherals && payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["peripherals"], message: "peripherals are only supported for escpos protocol" });
    }
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

  return { type: "escpos", protocol: "escpos", encoding: "base64", data: Buffer.from(lines, "binary").toString("base64") };
}

const TEST_PAGE_BYTES = 4096;

function safeTestText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}

/**
 * Build a test ticket in the LANGUAGE THE PRINTER ACTUALLY SPEAKS. An
 * ESC/POS ticket sent to a ZPL printer is garbage, and the strict capability
 * model now rejects it — so the gateway (like the Odoo router's
 * route_test_page) selects the template from the printer's declared
 * protocol. Document transports (spooler/ipp with no byte protocol) have no
 * honest canned ticket; callers must surface that instead of faking one.
 */
export function buildTestPrintPayloadForPrinter(
  printerName: string,
  agentName: string,
  printer: { protocol?: string | null; connectionType?: string | null; capabilities?: { supported_protocols?: string[] } | null },
): PrintJobPayload {
  const declared = (printer.protocol ?? "").toLowerCase();
  const supported = (printer.capabilities?.supported_protocols ?? []).map((p) => String(p).toLowerCase());
  const byteProto = ["escpos", "zpl", "tspl", "raw"].includes(declared)
    ? declared
    : (["escpos", "zpl", "tspl", "raw"] as const).find((p) => supported.includes(p)) ?? "";
  const name = safeTestText(printerName);
  const agent = safeTestText(agentName);
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);

  if (byteProto === "escpos") {
    return buildTestPrintPayload(printerName, agentName);
  }
  if (byteProto === "zpl") {
    const zpl = [
      "^XA",
      "^FO50,50^A0N,36,36^FDODOO PRINT GATEWAY TEST PAGE^FS",
      "^FO50,100^GB700,2,2^FS",
      `^FO50,120^A0N,28,28^FDPrinter : ${name}^FS`,
      `^FO50,160^A0N,28,28^FDAgent   : ${agent}^FS`,
      `^FO50,200^A0N,28,28^FDStatus  : OK | ${stamp}^FS`,
      "^XZ",
    ].join("\n");
    if (Buffer.byteLength(zpl, "utf-8") > TEST_PAGE_BYTES) throw new Error("test page exceeds limit");
    return { type: "raw", protocol: "zpl", encoding: "base64", data: Buffer.from(zpl, "utf-8").toString("base64") };
  }
  if (byteProto === "tspl") {
    const tspl = [
      "SIZE 75 mm, 50 mm",
      "GAP 2 mm, 0 mm",
      "DIRECTION 1",
      "CLS",
      'TEXT 50,40,"3",0,1,1,"ODOO PRINT GATEWAY TEST PAGE"',
      `TEXT 50,80,"2",0,1,1,"Printer : ${name}"`,
      `TEXT 50,110,"2",0,1,1,"Agent   : ${agent}"`,
      `TEXT 50,140,"2",0,1,1,"Status  : OK | ${stamp}"`,
      "PRINT 1,1",
    ].join("\n");
    if (Buffer.byteLength(tspl, "utf-8") > TEST_PAGE_BYTES) throw new Error("test page exceeds limit");
    return { type: "raw", protocol: "tspl", encoding: "base64", data: Buffer.from(tspl, "utf-8").toString("base64") };
  }
  if (byteProto === "raw") {
    const raw = [
      "================================",
      "  ODOO PRINT GATEWAY TEST PAGE ",
      "================================",
      `Printer : ${name}`,
      `Agent   : ${agent}`,
      "Protocol: RAW",
      "--------------------------------",
      `Status  : OK | ${stamp}`,
      "================================\n\n\n",
    ].join("\n");
    return { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from(raw, "utf-8").toString("base64") };
  }
  throw new Error("This printer transport (spooler/IPP document queue) has no printable canned test ticket; print a real report to validate the path.");
}