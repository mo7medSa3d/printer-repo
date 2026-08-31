import { NextResponse } from "next/server";
import { db } from "@/db";
import { branches } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db.select().from(branches).orderBy(desc(branches.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { name?: unknown; description?: unknown; location?: unknown; timezone?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Default Branch";
  const id = `branch_${nanoid(8)}`;
  await db.insert(branches).values({
    id,
    name,
    description: typeof body.description === "string" ? body.description : null,
    location: typeof body.location === "string" ? body.location : null,
    timezone: typeof body.timezone === "string" ? body.timezone : null,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
  });

  return NextResponse.json({ id, name }, { status: 201 });
}
