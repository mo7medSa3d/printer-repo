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

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Unnamed Destination";
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : "other";
  const destinationId = `dest_${nanoid(8)}`;

  await db.insert(destinations).values({
    id: destinationId,
    branchId: id,
    name,
    type,
    description: typeof body.description === "string" ? body.description : null,
    zone: typeof body.zone === "string" ? body.zone : null,
    enabled: typeof body.enabled === "boolean" ? body.enabled : true,
  });

  return NextResponse.json({ id: destinationId, branchId: id, name, type }, { status: 201 });
}
