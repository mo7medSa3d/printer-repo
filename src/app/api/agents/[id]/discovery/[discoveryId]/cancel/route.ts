import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { discoverySessions } from "../../../../../../../db/schema";
import { validateManager } from "../../../../../../../lib/manager-auth";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; discoveryId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { discoveryId } = await params;
  const session = await db.query.discoverySessions.findFirst({ where: eq(discoverySessions.id, discoveryId) });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.status !== "running") return NextResponse.json({ error: `Already ${session.status}` }, { status: 409 });
  await db.update(discoverySessions).set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(discoverySessions.id, discoveryId)));
  return NextResponse.json({ ok: true, status: "cancelled" });
}
