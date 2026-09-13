import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { printJobs } from "../../../../../db/schema";
import { isOdooKeyAllowedForDocumentType, validateOdooKey } from "../../../../../lib/odoo-auth";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { and, inArray, eq } from "drizzle-orm";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024 * 1024;

const batchQuerySchema = z.object({
  jobIds: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
}).strict();

function responseForRow(row: typeof printJobs.$inferSelect) {
  return {
    jobId: row.id,
    status: row.status,
    printerId: row.printerId,
    agentId: row.agentId,
    destination: row.destination,
    documentType: row.documentType,
    error: row.error,
    deliveredAt: row.deliveredAt,
    ackedAt: row.ackedAt,
    updatedAt: row.updatedAt,
  };
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, MAX_BODY)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  const odoo = await validateOdooKey(req);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_BODY", retryable: false }, { status: 400 });
  }

  const parsed = batchQuerySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid jobIds array", code: "INVALID_PAYLOAD", retryable: false }, { status: 400 });
  }

  const uniqueIds = Array.from(new Set(parsed.data.jobIds));
  const rows = await db.query.printJobs.findMany({
    where: and(
      inArray(printJobs.id, uniqueIds),
      eq(printJobs.tenantId, odoo.tenantId),
      eq(printJobs.apiKeyId, odoo.id),
    ),
  });

  const allowedRows = rows.filter((row) => isOdooKeyAllowedForDocumentType(odoo, row.documentType, "read"));
  const jobs = allowedRows.map(responseForRow);

  return NextResponse.json({ jobs }, { status: 200 });
}
