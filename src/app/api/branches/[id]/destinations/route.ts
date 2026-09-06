import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { destinations } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const rows = await db.select().from(destinations)
    .where(eq(destinations.branchId, id))
    .orderBy(desc(destinations.createdAt));

  return NextResponse.json(rows);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { name?: unknown; type?: unknown; description?: unknown; zone?: unknown; enabled?: unknown };
  try { body = await req.json(); } catch { body = {}; }

  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (rawName.length > 120) return NextResponse.json({ error: "name must be <= 120 characters" }, { status: 400 });
  const name = rawName || "Unnamed Destination";
  const rawType = typeof body.type === "string" ? body.type.trim() : "";
  if (rawType.length > 60) return NextResponse.json({ error: "type must be <= 60 characters" }, { status: 400 });
  const type = rawType || "other";
  const description = typeof body.description === "string" ? body.description.slice(0, 500) : null;
  const zone = typeof body.zone === "string" ? body.zone.slice(0, 120) : null;
  const destinationId = `dest_${nanoid(8)}`;

  await db.insert(destinations).values({
    id: destinationId,
    branchId: id,
    name,
    type,
    description,
    zone,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
  });

  return NextResponse.json({ id: destinationId, branchId: id, name, type }, { status: 201 });
}
