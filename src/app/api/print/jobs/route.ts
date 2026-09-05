import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, branches, printJobs, printers } from "../../../../db/schema";
import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "../../../../lib/odoo-auth";
import { validatePrintJobPayload } from "../../../../lib/payload";
import { resolvePrinterForJob } from "../../../../lib/routing";
import { requestIdFrom } from "../../../../lib/log";
import { incrementMetric } from "../../../../lib/metrics";
import { AgentQueueFullError, AgentQueuedJobsFullError, BranchQueuedJobsFullError, createPrintJobForPrinter, PrintJobRateLimitError, MAX_AGENT_IN_FLIGHT_JOBS, MAX_AGENT_QUEUED_JOBS, MAX_BRANCH_QUEUED_JOBS, PRINT_JOB_RATE_LIMIT_PER_HOUR, PRINT_JOB_RATE_LIMIT_PER_MINUTE } from "../../../../lib/print-job-service";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_PRINT_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const legacyBodySchema = z.object({ printerId: z.string().min(1).max(120), payload: z.unknown(), expiresAt: z.string().optional(), idempotencyKey: z.string().max(200).optional() });
const branchBodySchema = z.object({ branchId: z.string().min(1).max(120), destinationId: z.string().min(1).max(120), documentType: z.string().min(1).max(120), payload: z.unknown(), expiresAt: z.string().optional(), idempotencyKey: z.string().max(200).optional() });

function parseExpiresAt(str?: string) {
  if (!str) return new Date(Date.now() + 60 * 60 * 1000);
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw new Error("expiresAt must be ISO8601");
  if (d.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");
  return d;
}

function errorStatus(message: string): number {
  if (/rate limit/i.test(message) || /PRINT_JOB_RATE_LIMITED/i.test(message)) return 429;
  if (/not online/i.test(message) || /QUEUE_FULL/i.test(message)) return 503;
  if (/virtual|redirected|disabled|retired/i.test(message)) return 409;
  if (/capability|cannot print/i.test(message)) return 422;
  if (/not found/i.test(message)) return 404;
  return 500;
}

function jobResponse(row: typeof printJobs.$inferSelect) {
  return { jobId: row.id, status: row.status, printerId: row.printerId, agentId: row.agentId, branchId: row.branchId, destinationId: row.destinationId, documentType: row.documentType };
}

function backpressureResponse(e: AgentQueueFullError | AgentQueuedJobsFullError | BranchQueuedJobsFullError) {
  if (e instanceof AgentQueueFullError) return { error: e.code, code: e.code, agentId: e.agentId, inFlight: e.inFlight, limit: MAX_AGENT_IN_FLIGHT_JOBS, retryable: true };
  if (e instanceof AgentQueuedJobsFullError) return { error: e.code, code: e.code, agentId: e.agentId, queued: e.queued, limit: MAX_AGENT_QUEUED_JOBS, retryable: true };
  return { error: e.code, code: e.code, branchId: e.branchId, queued: e.queued, limit: MAX_BRANCH_QUEUED_JOBS, retryable: true };
}

function rateLimitResponse(e: PrintJobRateLimitError) {
  return NextResponse.json({ error: e.code, code: e.code, retryable: true, retryAfterSeconds: e.retryAfterSeconds, limits: { perMinute: PRINT_JOB_RATE_LIMIT_PER_MINUTE, perHour: PRINT_JOB_RATE_LIMIT_PER_HOUR } }, {
    status: 429,
    headers: { "Retry-After": String(e.retryAfterSeconds), "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFrom(req);
  if (hasBodyOverLimit(req, MAX_PRINT_REQUEST_BODY_BYTES)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const branchRoute = branchBodySchema.safeParse(raw);
  const legacyRoute = legacyBodySchema.safeParse(raw);

  if (branchRoute.success) {
    const parsed = branchRoute.data;
    const odoo = await validateOdooKey(req, parsed.branchId);
    if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid branch-scoped Odoo API key)" }, { status: 401 });
    if (!isOdooKeyAllowedForDocumentType(odoo, parsed.documentType, "write")) return NextResponse.json({ error: "API key is not allowed to create this document type" }, { status: 403 });

    let validatedPayload: ReturnType<typeof validatePrintJobPayload>;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid payload" }, { status: 400 }); }

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 }); }

    if (parsed.idempotencyKey) {
      const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, parsed.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
      if (existing) return NextResponse.json(jobResponse(existing), { status: 200 });
    }

    const resolved = await resolvePrinterForJob({ branchId: parsed.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, payloadType: validatedPayload.type });
    if (!resolved) return NextResponse.json({ error: "INTERNAL_ERROR: routing returned no result" }, { status: 500 });
    if ("error" in resolved) {
      incrementMetric("routing_failures_total");
      const statusMap: Record<string, number> = { INVALID_BRANCH: 400, INVALID_DESTINATION: 400, NO_ROUTE: 404, NO_PRINTER_FOUND: 404, PRINTER_DISABLED: 409, PRINTER_VIRTUAL: 409, PRINTER_OFFLINE: 503, CAPABILITY_MISMATCH: 422, INTERNAL_ERROR: 500 };
      return NextResponse.json({ error: `${resolved.error}: ${resolved.message}`, code: resolved.error }, { status: statusMap[resolved.error] ?? 400 });
    }

    try {
      const result = await createPrintJobForPrinter(resolved.printer.id, validatedPayload, { requestedBy: "odoo", idempotencyKey: parsed.idempotencyKey ?? null, destinationId: parsed.destinationId, documentType: parsed.documentType, expiresAt, rateLimitKeyId: odoo.id });
      incrementMetric("print_jobs_created_total");
      return NextResponse.json({ jobId: result.id, status: result.status, printerId: result.printerId, agentId: result.agentId, branchId: result.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, ...(resolved.fallbackUsed ? { fallbackUsed: true, fallbackChain: resolved.fallbackChain } : {}) }, { status: 201 });
    } catch (e: unknown) {
      if (e instanceof PrintJobRateLimitError) {
        incrementMetric("print_jobs_rate_limited_total");
        return rateLimitResponse(e);
      }
      if (e instanceof AgentQueueFullError || e instanceof AgentQueuedJobsFullError || e instanceof BranchQueuedJobsFullError) {
        incrementMetric("print_jobs_backpressure_total");
        return NextResponse.json(backpressureResponse(e), { status: 503 });
      }
      if (e instanceof Error && e.message === "DUPLICATE_JOB" && parsed.idempotencyKey) {
        const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, parsed.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
        if (existing) return NextResponse.json(jobResponse(existing), { status: 200 });
      }
      const message = e instanceof Error ? e.message : "print job creation failed";
      console.warn(`[print/jobs] ${requestId}: ${message}`);
      return NextResponse.json({ error: message }, { status: errorStatus(message) });
    }
  }

  if (legacyRoute.success) {
    const parsed = legacyRoute.data;
    const odoo = await validateOdooKey(req);
    if (!odoo?.branchId) return NextResponse.json({ error: "Legacy direct printing requires a branch-scoped Odoo API key; migrate to /api/print/jobs routing" }, { status: 403 });
    if (!isOdooKeyAllowedForDocumentType(odoo, null, "write")) return NextResponse.json({ error: "API key is not allowed to create jobs" }, { status: 403 });

    const branch = await db.query.branches.findFirst({ where: eq(branches.id, odoo.branchId) });
    if (!branch || !branch.enabled) return NextResponse.json({ error: "Forbidden: key branch is disabled or missing" }, { status: 403 });

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 }); }

    let validatedPayload: ReturnType<typeof validatePrintJobPayload>;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid payload" }, { status: 400 }); }

    const printer = await db.query.printers.findFirst({ where: eq(printers.id, parsed.printerId) });
    if (!printer) return NextResponse.json({ error: "NO_PRINTER_FOUND: printerId not found" }, { status: 404 });
    const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
    if (!ownerAgent) return NextResponse.json({ error: "INTERNAL_ERROR: printer owner agent missing" }, { status: 500 });
    if (ownerAgent.branchId !== odoo.branchId) return NextResponse.json({ error: "Forbidden: printer belongs to another branch" }, { status: 403 });

    if (parsed.idempotencyKey) {
      const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, ownerAgent.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
      if (existing) return NextResponse.json(jobResponse(existing), { status: 200 });
    }

    try {
      const result = await createPrintJobForPrinter(parsed.printerId, validatedPayload, { requestedBy: "odoo-legacy", idempotencyKey: parsed.idempotencyKey ?? null, expiresAt, rateLimitKeyId: odoo.id });
      return NextResponse.json({ jobId: result.id, status: result.status, printerId: result.printerId, agentId: result.agentId, branchId: result.branchId }, { status: 201 });
    } catch (e: unknown) {
      if (e instanceof PrintJobRateLimitError) {
        incrementMetric("print_jobs_rate_limited_total");
        return rateLimitResponse(e);
      }
      if (e instanceof AgentQueueFullError || e instanceof AgentQueuedJobsFullError || e instanceof BranchQueuedJobsFullError) {
        incrementMetric("print_jobs_backpressure_total");
        return NextResponse.json(backpressureResponse(e), { status: 503 });
      }
      if (e instanceof Error && e.message === "DUPLICATE_JOB" && parsed.idempotencyKey) {
        const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, ownerAgent.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
        if (existing) return NextResponse.json(jobResponse(existing), { status: 200 });
      }
      const message = e instanceof Error ? e.message : "print job creation failed";
      console.warn(`[print/jobs] ${requestId}: ${message}`);
      return NextResponse.json({ error: message }, { status: errorStatus(message) });
    }
  }

  return NextResponse.json({ error: "Invalid body. Expected either legacy printerId or branch/destination/documentType request" }, { status: 400 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const branchIdFromQuery = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, branchIdFromQuery);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!odoo.branchId) return NextResponse.json({ error: "Branch-scoped API key required" }, { status: 403 });
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });
  const row = await db.query.printJobs.findFirst({ where: eq(printJobs.id, id) });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (odoo.branchId && row.branchId !== odoo.branchId) return NextResponse.json({ error: "Forbidden: key is scoped to another branch" }, { status: 403 });
  return NextResponse.json({ jobId: row.id, status: row.status, printerId: row.printerId, agentId: row.agentId, branchId: row.branchId, destinationId: row.destinationId, documentType: row.documentType, error: row.error, retries: row.retries, expiresAt: row.expiresAt, updatedAt: row.updatedAt });
}
