import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(["network", "usb", "spooler", "tcp", "ipp", "ipps"]).optional(),
  connectionType: z.enum(["network", "usb", "spooler", "tcp", "ipp", "ipps"]).optional(),
  printerType: z.enum(["thermal", "laser", "inkjet", "spooler", "other", "unknown"]).optional(),
  protocol: z.enum(["raw", "escpos", "ipp", "ipps", "spooler", "windows_spooler"]).optional(),
  branchId: z.string().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["online","offline","busy","error","unknown"]).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const row = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) update.name = parsed.data.name;
  if (parsed.data.type !== undefined) update.type = parsed.data.type;
  if (parsed.data.connectionType !== undefined) (update as any).connectionType = parsed.data.connectionType;
  if (parsed.data.printerType !== undefined) (update as any).printerType = parsed.data.printerType;
  if (parsed.data.protocol !== undefined) (update as any).protocol = parsed.data.protocol;
  if (parsed.data.branchId !== undefined) (update as any).branchId = parsed.data.branchId;
  if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
  if (parsed.data.config !== undefined) update.config = parsed.data.config;
  if (parsed.data.capabilities !== undefined) (update as any).capabilities = parsed.data.capabilities;
  if (parsed.data.status !== undefined) update.status = parsed.data.status;

  const [row] = await db.update(printers).set(update as never).where(eq(printers.id, id)).returning();
  return NextResponse.json(row);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.delete(printers).where(eq(printers.id, id));
  return NextResponse.json({ ok: true });
}
