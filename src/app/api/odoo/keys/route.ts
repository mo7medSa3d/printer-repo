import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      description: apiKeys.description,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body uses defaults */ }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : "Odoo";
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;
  const { raw, hashed, id } = generateOdooApiKey();

  await db.insert(apiKeys).values({ id, name, description, hashedKey: hashed });

  return NextResponse.json({
    id,
    name,
    description,
    apiKey: raw,
    note: "Copy this key now. The raw key will never be shown again.",
  }, { status: 201 });
}

export async function DELETE(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown = {};
  try { body = await req.json(); } catch { /* invalid body handled below */ }
  const id = body && typeof body === "object" && typeof (body as Record<string, unknown>).id === "string"
    ? String((body as Record<string, unknown>).id).trim()
    : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const revoked = await db.update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });
  if (!revoked.length) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  return NextResponse.json(revoked[0], { status: 200 });
}
