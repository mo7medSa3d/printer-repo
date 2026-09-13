import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canTransitionLifecycle } from "../../../../lib/lifecycle";
import { PRINTER_TYPES, CONNECTION_TYPES, PRINTER_PROTOCOLS, assertPrinterMetadataLimits } from "../../../../lib/printer-model";
import { writeAuditEvent } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  printerType: z.enum(PRINTER_TYPES).optional(),
  deviceClass: z.enum(["thermal", "laser", "inkjet", "label", "other", "unknown"]).optional(),
  connectionType: z.enum(CONNECTION_TYPES).optional(),
  protocol: z.enum(PRINTER_PROTOCOLS).optional(),
  lifecycle: z.enum(["active", "disabled", "retired"]).optional(),
  config: z.object({ ip: z.string().max(255).optional(), port: z.number().int().min(1).max(65535).optional(), vid: z.number().int().min(0).max(65535).optional(), pid: z.number().int().min(0).max(65535).optional(), serial: z.string().max(255).optional(), address: z.string().max(512).optional(), spooler_name: z.string().max(255).optional() }).strict().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["online", "offline", "busy", "error", "unknown"]).optional(),
}).strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }
  const { id } = await params;
  const row = await db.query.printers.findFirst({ where: and(eq(printers.id, id), eq(printers.tenantId, claims.tenantId)) });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (claims) { try { requireManagerPermission(claims, "printers.manage"); } catch { return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } }); } }
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await db.query.printers.findFirst({ where: and(eq(printers.id, id), eq(printers.tenantId, claims.tenantId)) });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body && typeof body === "object" && ("branchId" in body || "branch_id" in body || "enabled" in body || "type" in body)) {
    return NextResponse.json({ error: "Unsupported legacy/ownership field" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  try { assertPrinterMetadataLimits(parsed.data as unknown as Parameters<typeof assertPrinterMetadataLimits>[0]); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "printer metadata exceeds limits" }, { status: 400 }); }
  if (parsed.data.lifecycle && !canTransitionLifecycle(existing.lifecycle, parsed.data.lifecycle)) return NextResponse.json({ error: `invalid lifecycle transition: ${existing.lifecycle} -> ${parsed.data.lifecycle}` }, { status: 409 });
  if (parsed.data.lifecycle === "active") {
    const owner = await db.query.agents.findFirst({ where: and(eq(agents.id, existing.agentId), eq(agents.tenantId, claims.tenantId)) });
    if (!owner) return NextResponse.json({ error: "Printer owner agent missing" }, { status: 500 });
    if (owner.lifecycle !== "active") return NextResponse.json({ error: `cannot activate printer while agent is ${owner.lifecycle}` }, { status: 409 });
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "printerType", "deviceClass", "connectionType", "protocol", "config", "capabilities", "status", "lifecycle"] as const) {
    const value = parsed.data[key];
    if (value !== undefined) update[key] = value;
  }
  if (parsed.data.connectionType || parsed.data.config) {
    const connectionType = parsed.data.connectionType ?? existing.connectionType;
    const cfg = (parsed.data.config ?? existing.config ?? {}) as Record<string, unknown>;
    const err = connectionType === "network" && (!cfg.ip || !cfg.port) ? "network printer requires config.ip and config.port" : connectionType === "spooler" && !(cfg.spooler_name || cfg.address) ? "spooler printer requires config.spooler_name or config.address" : null;
    if (err) return NextResponse.json({ error: err }, { status: 400 });
  }
  const [row] = await db.update(printers).set(update as never).where(and(eq(printers.id, id), eq(printers.tenantId, claims.tenantId))).returning();
  void writeAuditEvent({ tenantId: claims.tenantId, actorType: claims.userId ? "user" : "system", actorId: claims.userId ?? "legacy-manager", action: "printer.changed", resourceType: "printer", resourceId: id, metadata: { lifecycle: parsed.data.lifecycle ?? null } }).catch(() => undefined);
  return NextResponse.json(row);
}