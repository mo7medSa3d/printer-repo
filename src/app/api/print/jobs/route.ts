import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { validatePrintJobPayload } from "@/lib/payload";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { printJobs } from "@/db/schema";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  printerId: z.string().min(1),
  payload: z.unknown(),
  expiresAt: z.string().optional(),
  // optional idempotency key supplied by Odoo — if provided, we reuse existing job id if payload matches
  idempotencyKey: z.string().optional(),
});

export async function POST(req: Request) {
  const odoo = await validateOdooKey(req);
  if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid Odoo API key)" }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });

  const { printerId, payload, expiresAt: expiresAtStr, idempotencyKey } = parsed.data;

  // Validate printer exists and enabled
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, printerId) });
  if (!printer) return NextResponse.json({ error: "printerId not found" }, { status: 404 });
  if (printer.enabled === false) return NextResponse.json({ error: "printer disabled" }, { status: 409 });

  // Validate payload strictly (5 MiB cap inside)
  let validatedPayload;
  try {
    validatedPayload = validatePrintJobPayload(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid payload";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // expiresAt handling — default 1 hour, must be future, UTC
  let expiresAt: Date;
  if (expiresAtStr) {
    const d = new Date(expiresAtStr);
    if (isNaN(d.getTime())) return NextResponse.json({ error: "expiresAt must be ISO8601" }, { status: 400 });
    if (d.getTime() <= Date.now()) return NextResponse.json({ error: "expiresAt must be in the future" }, { status: 400 });
    expiresAt = d;
  } else {
    expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  }

  // Idempotency: if idempotencyKey provided and a job with that key already exists (stored as id), return it
  // For Phase 1 we use a deterministic id derived from odoo key + idempotencyKey hash if needed
  let jobId: string;
  if (idempotencyKey) {
    // Use a stable id so retry is idempotent — but keep job_ prefix
    const { createHash } = await import("crypto");
    const h = createHash("sha256").update(`${odoo.id}:${idempotencyKey}`).digest("hex").slice(0, 10);
    jobId = `job_${h}`;
    const existing = await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
    if (existing) {
      return NextResponse.json({ jobId: existing.id, status: existing.status, printerId: existing.printerId, agentId: existing.agentId }, { status: 200 });
    }
  } else {
    jobId = `job_${nanoid(10)}`;
  }

  await db.insert(printJobs).values({
    id: jobId,
    agentId: printer.agentId,
    printerId: printer.id,
    status: "queued",
    payload: validatedPayload,
    expiresAt,
  });

  // Best-effort WS push to Agent (polling fallback covers offline).
  // On a successful push the job is claimed so the agent's status PATCHes
  // satisfy the claimed→… transition policy (src/lib/job-status.ts).
  try {
    const { pushJobToAgentWithClaim } = await import("@/server/ws");
    await pushJobToAgentWithClaim({ id: jobId, agentId: printer.agentId, printerId: printer.id, payload: validatedPayload, expiresAt });
  } catch {}

  return NextResponse.json({ jobId, status: "queued", printerId: printer.id, agentId: printer.agentId }, { status: 201 });
}

export async function GET(req: Request) {
  // Odoo can poll job status: GET /api/print/jobs?id=job_xxx  or  GET /api/print/jobs?printerId=...
  const odoo = await validateOdooKey(req);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const row = await db.query.printJobs.findFirst({ where: eq(printJobs.id, id) });
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ jobId: row.id, status: row.status, printerId: row.printerId, agentId: row.agentId, error: row.error, retries: row.retries, expiresAt: row.expiresAt, updatedAt: row.updatedAt });
  }
  return NextResponse.json({ error: "id query param required" }, { status: 400 });
}
