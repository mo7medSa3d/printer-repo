import { NextResponse } from "next/server";
import { db } from "@/db";
import { printJobs, printers } from "@/db/schema";
import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "@/lib/odoo-auth";
import { validatePrintJobPayload } from "@/lib/payload";
import { resolvePrinterForJob } from "@/lib/routing";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

export const dynamic = "force-dynamic";

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

async function createQueuedJob({
  jobId,
  printer,
  validatedPayload,
  expiresAt,
  branchId,
  destinationId,
  documentType,
  requestedBy,
}: {
  jobId: string;
  printer: { id: string; agentId: string; branchId?: string | null };
  validatedPayload: ReturnType<typeof validatePrintJobPayload>;
  expiresAt: Date;
  branchId?: string | null;
  destinationId?: string | null;
  documentType?: string | null;
  requestedBy?: string | null;
}) {
  await db.insert(printJobs).values({
    id: jobId,
    branchId: branchId ?? printer.branchId ?? null,
    destinationId: destinationId ?? null,
    documentType: documentType ?? null,
    agentId: printer.agentId,
    printerId: printer.id,
    status: "queued",
    payload: validatedPayload,
    requestedBy: requestedBy ?? "odoo",
    expiresAt,
  });

  try {
    const { pushJobToAgentWithClaim } = await import("@/server/ws");
    await pushJobToAgentWithClaim({ id: jobId, agentId: printer.agentId, printerId: printer.id, payload: validatedPayload, expiresAt });
  } catch {}
}

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const branchRoute = branchBodySchema.safeParse(raw);
  const legacyRoute = legacyBodySchema.safeParse(raw);

  if (branchRoute.success) {
    const parsed = branchRoute.data;
    const odoo = await validateOdooKey(req, parsed.branchId);
    if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid branch-scoped Odoo API key)" }, { status: 401 });
    if (!isOdooKeyAllowedForDocumentType(odoo, parsed.documentType, "write")) {
      return NextResponse.json({ error: "API key is not allowed to create this document type" }, { status: 403 });
    }

    let validatedPayload;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid payload";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 });
    }

    let jobId: string;
    if (parsed.idempotencyKey) {
      const { createHash } = await import("crypto");
      const h = createHash("sha256").update(`${odoo.id}:${parsed.idempotencyKey}`).digest("hex").slice(0, 10);
      jobId = `job_${h}`;
      const existing = await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
      if (existing) {
        return NextResponse.json({
          jobId: existing.id,
          status: existing.status,
          printerId: existing.printerId,
          agentId: existing.agentId,
          branchId: existing.branchId,
          destinationId: existing.destinationId,
          documentType: existing.documentType,
        }, { status: 200 });
      }
    } else {
      jobId = `job_${nanoid(10)}`;
    }

    const resolved = await resolvePrinterForJob({
      branchId: parsed.branchId,
      destinationId: parsed.destinationId,
      documentType: parsed.documentType,
      payloadType: (validatedPayload as any)?.type ?? null,
    });
    if (!resolved) {
      return NextResponse.json({ error: "NO_PRINTER_FOUND: No printer binding matched branchId/destinationId/documentType" }, { status: 404 });
    }
    if ("error" in resolved) {
      const code = (resolved as { error: string }).error;
      const msg = (resolved as { message: string }).message;
      const statusMap: Record<string, number> = {
        INVALID_BRANCH: 400,
        INVALID_DESTINATION: 400,
        NO_ROUTE: 404,
        NO_PRINTER_FOUND: 404,
        PRINTER_DISABLED: 409,
        PRINTER_OFFLINE: 503,
        CAPABILITY_MISMATCH: 422,
      };
      const httpStatus = statusMap[code] ?? 400;
      return NextResponse.json({ error: `${code}: ${msg}`, code }, { status: httpStatus });
    }

    await createQueuedJob({
      jobId,
      printer: resolved.printer,
      validatedPayload,
      expiresAt,
      branchId: parsed.branchId,
      destinationId: parsed.destinationId,
      documentType: parsed.documentType,
      requestedBy: "odoo",
    });

    // Auditable fallback info
    const fallbackInfo = resolved.fallbackUsed ? { fallbackUsed: true, fallbackChain: resolved.fallbackChain } : {};

    return NextResponse.json({
      jobId,
      status: "queued",
      printerId: resolved.printer.id,
      agentId: resolved.printer.agentId,
      branchId: parsed.branchId,
      destinationId: parsed.destinationId,
      documentType: parsed.documentType,
      ...fallbackInfo,
    }, { status: 201 });
  }

  if (legacyRoute.success) {
    const parsed = legacyRoute.data;
    const odoo = await validateOdooKey(req);
    if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid Odoo API key)" }, { status: 401 });
    if (!isOdooKeyAllowedForDocumentType(odoo, null, "write")) {
      return NextResponse.json({ error: "API key is not allowed to create jobs" }, { status: 403 });
    }

    let validatedPayload;
    try { validatedPayload = validatePrintJobPayload(parsed.payload); } catch (e) {
      const msg = e instanceof Error ? e.message : "invalid payload";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const printer = await db.query.printers.findFirst({ where: eq(printers.id, parsed.printerId) });
    if (!printer) return NextResponse.json({ error: "NO_PRINTER_FOUND: printerId not found" }, { status: 404 });
    if (printer.enabled === false) return NextResponse.json({ error: "PRINTER_DISABLED: printer disabled" }, { status: 409 });
    if ((printer as any).status === "offline" || (printer as any).status === "error") {
      return NextResponse.json({ error: "PRINTER_OFFLINE: printer is offline" }, { status: 503 });
    }
    // Capability validation for legacy path as well
    const capLegacy = (await import("@/lib/routing")).validatePayloadForPrinter((validatedPayload as any)?.type, {
      protocol: (printer as any).protocol,
      connectionType: (printer as any).connectionType,
      capabilities: (printer as any).capabilities,
    });
    if (!capLegacy.ok) {
      return NextResponse.json({ error: capLegacy.reason }, { status: 422 });
    }
    if (odoo.branchId && printer.branchId && odoo.branchId !== printer.branchId) {
      return NextResponse.json({ error: "Forbidden: key is scoped to another branch" }, { status: 403 });
    }

    let expiresAt: Date;
    try { expiresAt = parseExpiresAt(parsed.expiresAt); } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid expiresAt" }, { status: 400 });
    }

    let jobId: string;
    if (parsed.idempotencyKey) {
      const { createHash } = await import("crypto");
      const h = createHash("sha256").update(`${odoo.id}:${parsed.idempotencyKey}`).digest("hex").slice(0, 10);
      jobId = `job_${h}`;
      const existing = await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
      if (existing) {
        return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId }, { status: 200 });
      }
    } else {
      jobId = `job_${nanoid(10)}`;
    }

    await createQueuedJob({
      jobId,
      printer,
      validatedPayload,
      expiresAt,
      branchId: printer.branchId,
      requestedBy: "odoo-legacy",
    });

    return NextResponse.json({ jobId, status: "queued", printerId: printer.id, agentId: printer.agentId }, { status: 201 });
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
    if (odoo.branchId && row.branchId && row.branchId !== odoo.branchId) {
      return NextResponse.json({ error: "Forbidden: key is scoped to another branch" }, { status: 403 });
    }
    if (odoo.branchId && !row.branchId) {
      return NextResponse.json({ error: "Forbidden: job is not in this branch" }, { status: 403 });
    }
    return NextResponse.json({
      jobId: row.id,
      status: row.status,
      printerId: row.printerId,
      agentId: row.agentId,
      branchId: row.branchId,
      destinationId: row.destinationId,
      documentType: row.documentType,
      error: row.error,
      retries: row.retries,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
    });
  }
  return NextResponse.json({ error: "id query param required" }, { status: 400 });
}
