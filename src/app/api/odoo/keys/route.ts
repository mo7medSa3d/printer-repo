import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    scope: apiKeys.scope,
    createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt,
    revokedAt: apiKeys.revokedAt,
  }).from(apiKeys).orderBy(desc(apiKeys.createdAt));

  return NextResponse.json(rows);
}

/**
 * Odoo integration keys are Gateway-installation credentials, not branch
 * identities. Odoo owns company/destination/document routing; the Gateway
 * only authenticates the caller and executes the selected printer job.
 */
export async function POST(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { name?: unknown; description?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is valid */ }

  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim().slice(0, 120)
    : "Odoo";
  const description = typeof body.description === "string"
    ? body.description.slice(0, 500)
    : null;

  const { raw, hashed, id } = generateOdooApiKey();
  await db.insert(apiKeys).values({
    id,
    name,
    branchId: null,
    scope: "standard",
    description,
    hashedKey: hashed,
    allowedDocumentTypes: null,
  });

  return NextResponse.json({
    id,
    name,
    apiKey: raw,
    note: "Copy this key now. The raw secret is never shown again.",
  }, { status: 201 });
}

/** Soft-revoke a key while preserving an audit record. */
export async function DELETE(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { id?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const now = new Date();
  const updated = await db.update(apiKeys)
    .set({ revokedAt: now })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });

  if (!updated.length) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  return NextResponse.json(updated[0], { status: 200 });
}
