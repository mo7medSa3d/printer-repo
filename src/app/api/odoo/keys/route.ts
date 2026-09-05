import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    branchId: apiKeys.branchId,
    scope: apiKeys.scope,
    allowedDocumentTypes: apiKeys.allowedDocumentTypes,
    createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt,
    revokedAt: apiKeys.revokedAt,
  }).from(apiKeys).orderBy(desc(apiKeys.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { name?: unknown; branchId?: unknown; scope?: unknown; allowedDocumentTypes?: unknown; description?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Odoo";
  const branchId = typeof body.branchId === "string" && body.branchId.trim() ? body.branchId.trim() : null;
  const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "standard";
  const allowedDocumentTypes = Array.isArray(body.allowedDocumentTypes)
    ? body.allowedDocumentTypes.filter((value): value is string => typeof value === "string")
    : null;
  const { raw, hashed, id } = generateOdooApiKey();
  await db.insert(apiKeys).values({
    id,
    name,
    branchId,
    scope,
    description: typeof body.description === "string" ? body.description : null,
    hashedKey: hashed,
    allowedDocumentTypes: allowedDocumentTypes && allowedDocumentTypes.length > 0 ? allowedDocumentTypes : null,
  });
  return NextResponse.json({ id, name, branchId, scope, allowedDocumentTypes, apiKey: raw, note: "Store this key securely — it will not be shown again" }, { status: 201 });
}
