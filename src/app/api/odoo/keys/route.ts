import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { generateOdooApiKey } from "@/lib/odoo-auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Manager-only: list and create Odoo API keys. Raw key shown once.
export async function GET(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt }).from(apiKeys).orderBy(desc(apiKeys.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const m = await validateManager(req);
  if (!m) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { name?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Odoo";
  const { raw, hashed, id } = generateOdooApiKey();
  await db.insert(apiKeys).values({ id, name, hashedKey: hashed });
  return NextResponse.json({ id, name, apiKey: raw, note: "Store this key securely — it will not be shown again" }, { status: 201 });
}
