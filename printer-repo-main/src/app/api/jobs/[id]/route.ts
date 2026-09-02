import { NextResponse } from "next/server";
import { db } from "@/db";
import { printJobs } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await db.query.printJobs.findFirst({ where: eq(printJobs.id, id) });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}
