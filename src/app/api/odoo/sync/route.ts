import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, branches, destinations, printerBindings, documentTypes, printers, printJobs } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Odoo -> Gateway sync: idempotent upsert for branches/destinations/bindings.
// Supports cron/webhook style sync where Odoo is source of truth for business config.
// Each entry is upserted by id, never duplicated on repeated sync.

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Determine branch context for auth: if payload contains branches, use first branch id; else require branchId query param
  const branchIdFromBody = body?.branches?.[0]?.id ?? body?.branchId ?? null;
  const odoo = await validateOdooKey(req, branchIdFromBody);
  if (!odoo) return NextResponse.json({ error: "Unauthorized (invalid Odoo API key)" }, { status: 401 });

  const results: Record<string, any> = { branches: [], destinations: [], documentTypes: [], bindings: [] };

  // Sync branches
  if (Array.isArray(body.branches)) {
    for (const b of body.branches) {
      if (!b.id || !b.name) continue;
      if (odoo.branchId && b.id !== odoo.branchId) {
        results.branches.push({ id: b.id, error: "branch mismatch with API key scope" });
        continue;
      }
      const existing = await db.query.branches.findFirst({ where: eq(branches.id, b.id) });
      if (existing) {
        await db.update(branches).set({
          name: b.name,
          description: b.description ?? existing.description,
          location: b.location ?? existing.location,
          enabled: typeof b.enabled === "boolean" ? b.enabled : existing.enabled,
          updatedAt: new Date(),
        }).where(eq(branches.id, b.id));
        results.branches.push({ id: b.id, action: "updated" });
      } else {
        await db.insert(branches).values({
          id: b.id,
          name: b.name,
          description: b.description ?? null,
          location: b.location ?? null,
          enabled: typeof b.enabled === "boolean" ? b.enabled : true,
        });
        results.branches.push({ id: b.id, action: "created" });
      }
    }
  }

  // Sync destinations
  if (Array.isArray(body.destinations)) {
    for (const d of body.destinations) {
      if (!d.id || !d.branchId || !d.name || !d.type) continue;
      if (odoo.branchId && d.branchId !== odoo.branchId) {
        results.destinations.push({ id: d.id, error: "branch mismatch" });
        continue;
      }
      const existing = await db.query.destinations.findFirst({ where: eq(destinations.id, d.id) });
      if (existing) {
        await db.update(destinations).set({
          branchId: d.branchId,
          name: d.name,
          type: d.type,
          description: d.description ?? existing.description,
          zone: d.zone ?? existing.zone,
          enabled: typeof d.enabled === "boolean" ? d.enabled : existing.enabled,
          updatedAt: new Date(),
        }).where(eq(destinations.id, d.id));
        results.destinations.push({ id: d.id, action: "updated" });
      } else {
        await db.insert(destinations).values({
          id: d.id,
          branchId: d.branchId,
          name: d.name,
          type: d.type,
          description: d.description ?? null,
          zone: d.zone ?? null,
          enabled: typeof d.enabled === "boolean" ? d.enabled : true,
        });
        results.destinations.push({ id: d.id, action: "created" });
      }
    }
  }

  // Sync document types
  if (Array.isArray(body.documentTypes) || Array.isArray(body.document_types)) {
    const docs = body.documentTypes ?? body.document_types;
    for (const d of docs) {
      if (!d.id || !d.branchId || !d.name) continue;
      if (odoo.branchId && d.branchId !== odoo.branchId) {
        results.documentTypes.push({ id: d.id, error: "branch mismatch" });
        continue;
      }
      const existing = await db.query.documentTypes.findFirst({ where: eq(documentTypes.id, d.id) });
      if (existing) {
        await db.update(documentTypes).set({
          branchId: d.branchId,
          name: d.name,
          description: d.description ?? existing.description,
          payloadHint: d.payloadHint ?? d.payload_hint ?? existing.payloadHint,
          enabled: typeof d.enabled === "boolean" ? d.enabled : existing.enabled,
          updatedAt: new Date(),
        }).where(eq(documentTypes.id, d.id));
        results.documentTypes.push({ id: d.id, action: "updated" });
      } else {
        await db.insert(documentTypes).values({
          id: d.id,
          branchId: d.branchId,
          name: d.name,
          description: d.description ?? null,
          payloadHint: d.payloadHint ?? d.payload_hint ?? null,
          enabled: typeof d.enabled === "boolean" ? d.enabled : true,
        });
        results.documentTypes.push({ id: d.id, action: "created" });
      }
    }
  }

  // Sync bindings
  if (Array.isArray(body.bindings)) {
    for (const b of body.bindings) {
      if (!b.id || !b.branchId || !b.destinationId || !b.printerId) continue;
      if (odoo.branchId && b.branchId !== odoo.branchId) {
        results.bindings.push({ id: b.id, error: "branch mismatch" });
        continue;
      }
      const existing = await db.query.printerBindings.findFirst({ where: eq(printerBindings.id, b.id) });
      if (existing) {
        await db.update(printerBindings).set({
          branchId: b.branchId,
          destinationId: b.destinationId,
          documentType: b.documentType ?? existing.documentType,
          printerId: b.printerId,
          priority: typeof b.priority === "number" ? b.priority : existing.priority,
          enabled: typeof b.enabled === "boolean" ? b.enabled : existing.enabled,
          updatedAt: new Date(),
        }).where(eq(printerBindings.id, b.id));
        results.bindings.push({ id: b.id, action: "updated" });
      } else {
        await db.insert(printerBindings).values({
          id: b.id,
          branchId: b.branchId,
          destinationId: b.destinationId,
          documentType: b.documentType ?? null,
          printerId: b.printerId,
          priority: typeof b.priority === "number" ? b.priority : 1,
          enabled: typeof b.enabled === "boolean" ? b.enabled : true,
        });
        results.bindings.push({ id: b.id, action: "created" });
      }
    }
  }

  return NextResponse.json({ success: true, ...results });
}

// Gateway -> Odoo status visibility: Odoo can GET sync status for printers/agents/jobs in its branch
export async function GET(req: Request) {
  const url = new URL(req.url);
  const branchId = url.searchParams.get("branchId");
  const odoo = await validateOdooKey(req, branchId);
  if (!odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const branchFilter = branchId ?? odoo.branchId ?? null;
  // Return summary of agents/printers for this branch
  let agentRows: any[] = [];
  let printerRows: any[] = [];
  let jobRows: any[] = [];

  try {
    if (branchFilter) {
      agentRows = await db.select().from(agents).where(eq(agents.branchId, branchFilter)).orderBy(desc(agents.lastSeenAt)).limit(50);
      printerRows = await db.select().from(printers).where(eq(printers.branchId, branchFilter)).orderBy(desc(printers.updatedAt)).limit(100);
      jobRows = await db.select().from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);
    } else {
      agentRows = await db.select().from(agents).orderBy(desc(agents.lastSeenAt)).limit(20);
      printerRows = await db.select().from(printers).orderBy(desc(printers.updatedAt)).limit(20);
      jobRows = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(20);
    }
  } catch { }

  // Strip secrets
  const safeAgents = agentRows.map((a: any) => {
    const { secret, pairingCode, ...rest } = a;
    return rest;
  });

  return NextResponse.json({ branchId: branchFilter, agents: safeAgents, printers: printerRows, jobs: jobRows });
}
