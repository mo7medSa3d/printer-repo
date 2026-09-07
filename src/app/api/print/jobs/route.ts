import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { printJobs } from "../../../../db/schema";
import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "../../../../lib/odoo-auth";
import { validatePrintJobPayload, type PrintJobPayload } from "../../../../lib/payload";
import { createPrintJobForPrinter, PrintJobRateLimitError, AgentQueueFullError, AgentQueuedJobsFullError, PrintJobCapabilityError } from "../../../../lib/print-job-service";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024 * 1024;
const bodySchema = z.object({
  printerId: z.string().trim().min(1).max(120),
  documentType: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(255).optional(),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict();

function parseExpiresAt(value?: string) {
  const now = Date.now();
  if (!value) return new Date(now + 60 * 60 * 1000);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now) throw new Error("expiresAt must be in the future");
  if (parsed.getTime() - now > 24 * 60 * 60 * 1000) throw new Error("expiresAt exceeds the 24 hour maximum");
  return parsed;
}

function responseForRow(row: typeof printJobs.$inferSelect) {
  return {
    jobId: row.id,
    status: row.status,
    printerId: row.printerId,
    agentId: row.agentId,
    destination: row.destination,
    documentType: row.documentType,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function idempotencyFingerprint(request: {
  printerId: string;
  documentType?: string | null;
  destination?: string | null;
  payload: unknown;
}) {
  return JSON.stringify({
    printerId: request.printerId,
    documentType: request.documentType?.trim().toLowerCase() || null,
    destination: request.destination?.trim() || null,
    payload: canonicalize(request.payload),
  });
}

function idempotencyMatches(row: typeof printJobs.$inferSelect, request: {
  printerId: string;
  documentType: string;
  destination?: string;
  payload: PrintJobPayload;
}) {
  return idempotencyFingerprint(row) === idempotencyFingerprint(request);
}

function idempotencyConflict() {
  return NextResponse.json({ error: "IDEMPOTENCY_CONFLICT", code: "IDEMPOTENCY_CONFLICT", retryable: false }, { status: 409 });
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, MAX_BODY)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const odoo = await validateOdooKey(req);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  if (!isOdooKeyAllowedForDocumentType(odoo, parsed.data.documentType, "write")) {
    return NextResponse.json({
      error: "API key is not allowed to create this document type",
      code: "ODOO_KEY_NOT_ALLOWED",
      retryable: false,
    }, { status: 403 });
  }

  let payload: PrintJobPayload;
  try { payload = validatePrintJobPayload(parsed.data.payload); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid payload" }, { status: 400 }); }

  const request = { ...parsed.data, payload };
  let expiresAt: Date;
  try { expiresAt = parseExpiresAt(parsed.data.expiresAt); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid expiresAt" }, { status: 400 }); }

  if (parsed.data.idempotencyKey) {
    const existing = await db.query.printJobs.findFirst({
      where: and(eq(printJobs.apiKeyId, odoo.id), eq(printJobs.idempotencyKey, parsed.data.idempotencyKey)),
    });
    if (existing) {
      if (idempotencyMatches(existing, request)) return NextResponse.json(responseForRow(existing), { status: 200 });
      return idempotencyConflict();
    }
  }

  try {
    const result = await createPrintJobForPrinter(parsed.data.printerId, payload, {
      requestedBy: "odoo",
      idempotencyKey: parsed.data.idempotencyKey ?? null,
      destination: parsed.data.destination ?? null,
      documentType: parsed.data.documentType,
      expiresAt,
      rateLimitKeyId: odoo.id,
    });
    return NextResponse.json({
      jobId: result.id,
      status: result.status,
      printerId: result.printerId,
      agentId: result.agentId,
      destination: parsed.data.destination ?? null,
      documentType: parsed.data.documentType,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof PrintJobRateLimitError) {
      return NextResponse.json({ error: error.code, retryable: true, retryAfterSeconds: error.retryAfterSeconds }, {
        status: 429,
        headers: { "Retry-After": String(error.retryAfterSeconds), "Cache-Control": "no-store" },
      });
    }
    if (error instanceof AgentQueueFullError || error instanceof AgentQueuedJobsFullError) {
      return NextResponse.json({ error: error.code, code: error.code, retryable: true }, { status: 503 });
    }
    if (error instanceof PrintJobCapabilityError) {
      return NextResponse.json({ error: error.message, code: error.code, retryable: false }, { status: 422 });
    }
    if (error instanceof Error && (error as Error & { code?: string }).code === "DUPLICATE_JOB" && parsed.data.idempotencyKey) {
      const existing = await db.query.printJobs.findFirst({
        where: and(eq(printJobs.apiKeyId, odoo.id), eq(printJobs.idempotencyKey, parsed.data.idempotencyKey)),
      });
      if (existing && idempotencyMatches(existing, request)) return NextResponse.json(responseForRow(existing), { status: 200 });
      return idempotencyConflict();
    }
    const message = error instanceof Error ? error.message : "print job creation failed";
    const status = /not found/i.test(message) ? 404 : /not online|disabled|virtual|retired/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(req: Request) {
  const odoo = await validateOdooKey(req);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const row = await db.query.printJobs.findFirst({
    where: and(eq(printJobs.id, id), eq(printJobs.apiKeyId, odoo.id)),
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isOdooKeyAllowedForDocumentType(odoo, row.documentType, "read")) {
    return NextResponse.json({ error: "API key is not allowed to read this document type", code: "ODOO_KEY_NOT_ALLOWED", retryable: false }, { status: 403 });
  }
  return NextResponse.json(responseForRow(row), { status: 200 });
}
