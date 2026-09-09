import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { apiKeys } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { generateOdooApiKey } from "../../../../lib/odoo-auth";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

const keyInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  scope: z.enum(["standard", "read_only"]).default("standard"),
  // Empty/omitted list = all document types (installation-scoped key).
  allowedDocumentTypes: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
}).strict();

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      description: apiKeys.description,
      scope: apiKeys.scope,
      allowedDocumentTypes: apiKeys.allowedDocumentTypes,
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
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = keyInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid key settings" }, { status: 400 });
  }
  const name = parsed.data.name ?? "Odoo";
  const description = parsed.data.description?.trim() || null;
  const { raw, hashed, id } = generateOdooApiKey();

  await db.insert(apiKeys).values({
    id,
    name,
    description,
    hashedKey: hashed,
    scope: parsed.data.scope,
    allowedDocumentTypes: parsed.data.allowedDocumentTypes?.length ? parsed.data.allowedDocumentTypes : null,
  });

  return NextResponse.json({
    id,
    name,
    description,
    scope: parsed.data.scope,
    allowedDocumentTypes: parsed.data.allowedDocumentTypes ?? null,
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
