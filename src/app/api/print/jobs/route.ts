import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printJobs, printers } from "@/db/schema";
import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "@/lib/odoo-auth";
import { validatePrintJobPayload } from "@/lib/payload";
import { resolvePrinterForJob, validatePayloadForPrinter } from "@/lib/routing";
import { isVirtualPrinterRecord } from "@/lib/printer-virtual";
import { claimAndPushJobToAgent } from "@/server/ws";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logInfo, logWarn, requestIdFrom } from "@/lib/log";
import { incrementMetric } from "@/lib/metrics";

export const dynamic = "force-dynamic";

// Hard upper bound on jobs an agent can have concurrently owned by the
// gateway. This protects a wedged agent from accumulating an unbounded
// claimed/printing backlog while still allowing stale claims to recover.
export const MAX_AGENT_IN_FLIGHT_JOBS = 500;

const legacyBodySchema = z.object({
  printerId: z.string().min(1),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const branchBodySchema = z.object({
  branchId: z.string().min(1),
  destinationId: z.string().min(1),
  documentType: z.string().min(1),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

function parseExpiresAt(str?: string) {
  if (!str) return new Date(Date.now() + 60 * 60 * 1000);
  const d = new Date(str);
  if (isNaN(d.getTime())) throw new Error("expiresAt must be ISO8601");
  if (d.getTime() <= Date.now()) throw new Error("expiresAt must be in the future");
  return d;
}

class AgentQueueFullError extends Error {
  code = "AGENT_QUEUE_FULL" as const;
  constructor(public readonly agentId: string, public readonly inFlight: number) {
    super(`Agent ${agentId} has reached the maximum of ${MAX_AGENT_IN_FLIGHT_JOBS} in-flight jobs`);
  }
}

/**
 * Atomically reserve a queue slot with the insert. A transaction-scoped
 * advisory lock serializes reservations for the same agent, preventing two
 * concurrent Odoo requests from both observing the same free capacity.
 * Existing idempotent operations are allowed through without consuming a
 * second slot.
 */
async function insertQueuedJobAtomically({
  jobId,
  printer,
  validatedPayload,
  expiresAt,
  branchId,
  destinationId,
  documentType,
  requestedBy,
  idempotencyKey,
}: {
  jobId: string;
  printer: { id: string; agentId: string };
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  branchId: string;
  destinationId?: string | null;
  documentType?: string | null;
  requestedBy?: string | null;
  idempotencyKey?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    // pg_advisory_xact_lock is released automatically when this transaction
    // commits/rolls back. hashtext collisions only cause harmless serialization.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${printer.agentId}))`);

    if (idempotencyKey) {
      const existing = await tx.execute(sql`
        SELECT id
        FROM print_jobs
        WHERE branch_id = ${branchId} AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `);
      if (existing.rows.length > 0) {
        const err: any = new Error("DUPLICATE_JOB");
        err.code = "DUPLICATE_JOB";
        throw err;
      }
    }

    const countResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM print_jobs
      WHERE agent_id = ${printer.agentId}
        AND status IN ('claimed', 'printing')
        AND expires_at > now()
    `);
    const inFlight = Number((countResult.rows[0] as { count?: number | string } | undefined)?.count ?? 0);
    if (inFlight >= MAX_AGENT_IN_FLIGHT_JOBS) {
      throw new AgentQueueFullError(printer.agentId, inFlight);
    }

    await tx.insert(printJobs).values({
      id: jobId,
      branchId,
      destinationId: destinationId ?? null,
      documentType: documentType ?? null,
      agentId: printer.agentId,
      printerId: printer.id,
      status: "queued",
      payload: validatedPayload,
      requestedBy: requestedBy ?? "odoo",
      idempotencyKey: idempotencyKey ?? null,
      expiresAt,
    });
  });
}

async function createQueuedJob({
  jobId,
  printer,
  validatedPayload,
  expiresAt,
  branchId,
  destinationId,
  documentType,
  requestedBy,
  idempotencyKey,
}: {
  jobId: string;
  printer: { id: string; agentId: string };
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  branchId?: string | null;
  destinationId?: string | null;
  documentType?: string | null;
  requestedBy?: string | null;
  idempotencyKey?: string | null;
}): Promise<"queued" | "claimed"> {
  try {
    if (!branchId) throw new Error("Printer branch must be resolved from its Agent before job creation");
    await insertQueuedJobAtomically({
      jobId,
      printer,
      validatedPayload,
      expiresAt,
      branchId,
      destinationId,
      documentType,
      requestedBy,
      idempotencyKey,
    });
  } catch (e: any) {
    if (e instanceof AgentQueueFullError || e?.code === "AGENT_QUEUE_FULL") throw e;
    const isUniqueViolation =
      e?.code === "23505" ||
      e?.cause?.code === "23505" ||
      String(e?.message ?? "").includes("duplicate key") ||
      String(e?.cause?.message ?? "").includes("duplicate key");
    if (isUniqueViolation || e?.code === "DUPLICATE_JOB") {
      const err: any = new Error("DUPLICATE_JOB");
      err.code = "DUPLICATE_JOB";
      err.jobId = jobId;
      throw err;
    }
    throw e;
  }

  // Claim-before-delivery: the job is only handed to the agent after the
  // gateway has atomically taken ownership of it (queued -> claimed).
  try {
    const outcome = await claimAndPushJobToAgent({ id: jobId, agentId: printer.agentId });
    if (outcome === "delivered") return "claimed";
    if (outcome === "failed") {
      console.warn(`[print/jobs] job ${jobId} could not be delivered over WS and exhausted its delivery budget`);
    }
    return "queued";
  } catch (e) {
    console.warn(`[print/jobs] WS push failed for job ${jobId}:`, e);
    return "queued";
  }
}

export async function POST(req: Request) {
  const requestId = requestIdFrom(req);
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const branchRoute = branchBodySchema.safeParse(raw);
  const legacyRoute = legacyBodySchema.safeParse(raw);

  if (branchRoute.success) {
    const parsed = branchRoute.data;
    const odoo = await validateOdooKey(req, parsed.branchId);
    if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid branch-scoped Odoo API key)" }, { status: 401 });
    if (!isOdooKeyAllowedForDocumentType(odoo, parsed.documentType, "write")) return NextResponse.json({ error: "API key is not allowed to create this document type" }, { status: 403 });

    let validatedPayload;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "invalid payload" }, { status: 400 });
    }

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 });
    }

    let jobId: string;
    if (parsed.idempotencyKey) {
      const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, parsed.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
      if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId, branchId: existing.branchId, destinationId: existing.destinationId, documentType: existing.documentType }, { status: 200 });
    }
    jobId = `job_${nanoid(12)}`;

    const resolved = await resolvePrinterForJob({ branchId: parsed.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, payloadType: (validatedPayload as { type?: string | null })?.type ?? null });
    if (!resolved) return NextResponse.json({ error: "INTERNAL_ERROR: routing returned no result" }, { status: 500 });
    if ("error" in resolved) {
      incrementMetric("routing_failures_total");
      const code = resolved.error;
      const msg = resolved.message;
      const statusMap: Record<string, number> = { INVALID_BRANCH: 400, INVALID_DESTINATION: 400, NO_ROUTE: 404, NO_PRINTER_FOUND: 404, PRINTER_DISABLED: 409, PRINTER_VIRTUAL: 409, PRINTER_OFFLINE: 503, CAPABILITY_MISMATCH: 422, INTERNAL_ERROR: 500 };
      return NextResponse.json({ error: `${code}: ${msg}`, code }, { status: statusMap[code] ?? 400 });
    }

    let effectiveStatus: "queued" | "claimed" = "queued";
    try {
      effectiveStatus = await createQueuedJob({ jobId, printer: resolved.printer, validatedPayload, expiresAt, branchId: parsed.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, requestedBy: "odoo", idempotencyKey: parsed.idempotencyKey ?? null });
    } catch (e: any) {
      if (e?.code === "AGENT_QUEUE_FULL" || e instanceof AgentQueueFullError) {
        incrementMetric("print_jobs_backpressure_total");
        logWarn("print.job.queue_full", { requestId, agentId: resolved.printer.agentId, inFlight: e.inFlight ?? MAX_AGENT_IN_FLIGHT_JOBS });
        return NextResponse.json({ error: "AGENT_QUEUE_FULL", code: "AGENT_QUEUE_FULL", agentId: resolved.printer.agentId, inFlight: e.inFlight ?? MAX_AGENT_IN_FLIGHT_JOBS, limit: MAX_AGENT_IN_FLIGHT_JOBS, retryable: true }, { status: 503 });
      }
      if (e?.code === "DUPLICATE_JOB") {
        const existing = parsed.idempotencyKey ? await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, parsed.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) }) : await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
        if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId, branchId: existing.branchId, destinationId: existing.destinationId, documentType: existing.documentType }, { status: 200 });
      }
      throw e;
    }

    const fallbackInfo = resolved.fallbackUsed ? { fallbackUsed: true, fallbackChain: resolved.fallbackChain } : {};
    incrementMetric("print_jobs_created_total");
    logInfo("print.job.created", { requestId, jobId, branchId: parsed.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, printerId: resolved.printer.id, agentId: resolved.printer.agentId, status: effectiveStatus });
    return NextResponse.json({ jobId, status: effectiveStatus, printerId: resolved.printer.id, agentId: resolved.printer.agentId, branchId: parsed.branchId, destinationId: parsed.destinationId, documentType: parsed.documentType, ...fallbackInfo }, { status: 201 });
  }

  if (legacyRoute.success) {
    const parsed = legacyRoute.data;
    const odoo = await validateOdooKey(req);
    if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid Odoo API key)" }, { status: 401 });
    if (!isOdooKeyAllowedForDocumentType(odoo, null, "write")) return NextResponse.json({ error: "API key is not allowed to create jobs" }, { status: 403 });

    let validatedPayload;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "invalid payload" }, { status: 400 }); }

    const printer = await db.query.printers.findFirst({ where: eq(printers.id, parsed.printerId) });
    if (!printer) return NextResponse.json({ error: "NO_PRINTER_FOUND: printerId not found" }, { status: 404 });
    if (printer.lifecycle !== "active") return NextResponse.json({ error: `PRINTER_DISABLED: printer is ${printer.lifecycle}` }, { status: 409 });
    if (isVirtualPrinterRecord(printer)) return NextResponse.json({ error: "PRINTER_VIRTUAL: printer is virtual or redirected" }, { status: 409 });
    if ((printer as { status: string }).status === "offline" || (printer as { status: string }).status === "error") return NextResponse.json({ error: "PRINTER_OFFLINE: printer is offline" }, { status: 503 });

    const capLegacy = validatePayloadForPrinter((validatedPayload as { type?: string | null })?.type, { protocol: (printer as { protocol: string | null }).protocol, connectionType: (printer as { connectionType: string | null }).connectionType, capabilities: (printer as { capabilities: { supported_protocols?: string[] } | null }).capabilities });
    if (!capLegacy.ok) return NextResponse.json({ error: capLegacy.reason }, { status: 422 });
    const ownerAgent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
    if (!ownerAgent) return NextResponse.json({ error: "INTERNAL_ERROR: printer owner agent missing" }, { status: 500 });
    if (ownerAgent.lifecycle !== "active") return NextResponse.json({ error: `AGENT_DISABLED: agent is ${ownerAgent.lifecycle}` }, { status: 409 });
    if (odoo.branchId && ownerAgent.branchId !== odoo.branchId) return NextResponse.json({ error: "Forbidden: key is scoped to another branch" }, { status: 403 });

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 }); }

    let jobId: string;
    const legacyBranchId = ownerAgent.branchId;
    if (parsed.idempotencyKey && legacyBranchId) {
      const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, legacyBranchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
      if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId }, { status: 200 });
    } else if (parsed.idempotencyKey && odoo.branchId) {
      const existing = await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, odoo.branchId), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) });
      if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId }, { status: 200 });
    }
    jobId = `job_${nanoid(12)}`;

    let legacyStatus: "queued" | "claimed" = "queued";
    try {
      legacyStatus = await createQueuedJob({ jobId, printer, validatedPayload, expiresAt, branchId: ownerAgent.branchId, requestedBy: "odoo-legacy", idempotencyKey: parsed.idempotencyKey ?? null });
    } catch (e: any) {
      if (e?.code === "AGENT_QUEUE_FULL" || e instanceof AgentQueueFullError) {
        incrementMetric("print_jobs_backpressure_total");
        logWarn("print.job.queue_full", { requestId, agentId: printer.agentId, inFlight: e.inFlight ?? MAX_AGENT_IN_FLIGHT_JOBS });
        return NextResponse.json({ error: "AGENT_QUEUE_FULL", code: "AGENT_QUEUE_FULL", agentId: printer.agentId, inFlight: e.inFlight ?? MAX_AGENT_IN_FLIGHT_JOBS, limit: MAX_AGENT_IN_FLIGHT_JOBS, retryable: true }, { status: 503 });
      }
      if (e?.code === "DUPLICATE_JOB") {
        const dedupBranch = ownerAgent.branchId ?? odoo.branchId;
        const existing = parsed.idempotencyKey && dedupBranch ? await db.query.printJobs.findFirst({ where: and(eq(printJobs.branchId, dedupBranch), eq(printJobs.idempotencyKey, parsed.idempotencyKey)) }) : await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
        if (existing) return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId }, { status: 200 });
      }
      throw e;
    }
    return NextResponse.json({ jobId, status: legacyStatus, printerId: printer.id, agentId: printer.agentId }, { status: 201 });
  }

  return NextResponse.json({ error: "Invalid body. Expected either legacy printerId or branch/destination/documentType request" }, { status: 400 });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const branchIdFromQuery = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, branchIdFromQuery);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = url.searchParams.get("id");
  if (id) {
    const row = await db.query.printJobs.findFirst({ where: eq(printJobs.id, id) });
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (odoo.branchId && row.branchId && row.branchId !== odoo.branchId) return NextResponse.json({ error: "Forbidden: key is scoped to another branch" }, { status: 403 });
    if (odoo.branchId && !row.branchId) return NextResponse.json({ error: "Forbidden: job is not in this branch" }, { status: 403 });
    return NextResponse.json({ jobId: row.id, status: row.status, printerId: row.printerId, agentId: row.agentId, branchId: row.branchId, destinationId: row.destinationId, documentType: row.documentType, error: row.error, retries: row.retries, expiresAt: row.expiresAt, updatedAt: row.updatedAt });
  }
  return NextResponse.json({ error: "id query param required" }, { status: 400 });
}
