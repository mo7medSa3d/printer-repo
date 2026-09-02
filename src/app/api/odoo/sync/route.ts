import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, branches, destinations, printerBindings, documentTypes, printers, printJobs } from "@/db/schema";
import { validateOdooKey } from "@/lib/odoo-auth";
import { eq, desc, inArray, and, notInArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Odoo → Gateway configuration sync.
 *
 * Ownership (never reversed):
 *   Odoo owns    → branches, destinations, document types, printer bindings
 *   Gateway owns → agents, physical printers, runtime printer status
 *
 * The endpoint is dependency-safe and all-or-nothing:
 *
 *   1. authenticate the Odoo API key
 *   2. resolve exactly one branch scope for the whole payload
 *   3. validate EVERYTHING (shape, branch ownership, cross references)
 *      before a single row is written
 *   4. apply every upsert inside ONE transaction (rollback on any failure)
 *
 * A binding may only reference a printer that has already been registered by
 * an agent; the gateway never invents printer rows from Odoo data. A missing
 * printer is reported as SYNC_DEPENDENCY_MISSING so Odoo can retry after the
 * agent registers, instead of the sync half-applying and reporting success.
 */

type Detail = {
  entity: "branch" | "destination" | "documentType" | "binding" | "payload";
  id?: string | null;
  reason: string;
  bindingId?: string;
  printerId?: string;
  destinationId?: string;
  branchId?: string | null;
};

/**
 * Gateway ids are text columns while Odoo record ids are integers. Every id
 * is normalized to a trimmed string exactly once, here, so `123` and `"123"`
 * are never compared as if they were different values (and never compared
 * loosely either).
 */
function asId(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

type BranchInput = { id: string; name: string; description: string | null; location: string | null; enabled: boolean };
type DestinationInput = { id: string; branchId: string; name: string; type: string; description: string | null; zone: string | null; enabled: boolean };
type DocumentTypeInput = { id: string; branchId: string; name: string; description: string | null; payloadHint: string | null; enabled: boolean };
type BindingInput = { id: string; branchId: string; destinationId: string; documentType: string | null; printerId: string; priority: number; enabled: boolean };

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: "INVALID_JSON" }, { status: 400 }); }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "INVALID_JSON" }, { status: 400 });
  }

  const rawBranches: any[] = Array.isArray(body.branches) ? body.branches : [];
  const rawDestinations: any[] = Array.isArray(body.destinations) ? body.destinations : [];
  const rawDocumentTypes: any[] = Array.isArray(body.documentTypes)
    ? body.documentTypes
    : Array.isArray(body.document_types)
      ? body.document_types
      : [];
  const rawBindings: any[] = Array.isArray(body.bindings) ? body.bindings : [];

  // Branch context used for API-key scope validation.
  const branchIdFromBody = asId(rawBranches[0]?.id) ?? asId(body.branchId);
  const odoo = await validateOdooKey(req, branchIdFromBody);
  if (!odoo) return NextResponse.json({ success: false, error: "UNAUTHORIZED" }, { status: 401 });

  const keyBranchId = asId(odoo.branchId);
  const details: Detail[] = [];

  // ---------------------------------------------------------------- scope
  // One sync call carries exactly one branch. Mixing branches in a single
  // payload is rejected instead of silently syncing part of it.
  const branchIdsInPayload = new Set<string>();
  for (const b of rawBranches) { const id = asId(b?.id); if (id) branchIdsInPayload.add(id); }
  for (const d of rawDestinations) { const id = asId(d?.branchId ?? d?.branch_id); if (id) branchIdsInPayload.add(id); }
  for (const d of rawDocumentTypes) { const id = asId(d?.branchId ?? d?.branch_id); if (id) branchIdsInPayload.add(id); }
  for (const b of rawBindings) { const id = asId(b?.branchId ?? b?.branch_id); if (id) branchIdsInPayload.add(id); }
  if (keyBranchId) branchIdsInPayload.add(keyBranchId);

  if (branchIdsInPayload.size === 0) {
    return NextResponse.json(
      { success: false, error: "SYNC_VALIDATION_FAILED", details: [{ entity: "payload", reason: "no branch id could be resolved from the payload or the API key" }] },
      { status: 400 }
    );
  }
  if (branchIdsInPayload.size > 1) {
    return NextResponse.json(
      {
        success: false,
        error: "SYNC_VALIDATION_FAILED",
        details: [{ entity: "payload", reason: `a sync payload must target exactly one branch, got [${[...branchIdsInPayload].join(", ")}]` }],
      },
      { status: 400 }
    );
  }
  const branchId = [...branchIdsInPayload][0];

  if (keyBranchId && keyBranchId !== branchId) {
    return NextResponse.json(
      { success: false, error: "SYNC_VALIDATION_FAILED", details: [{ entity: "branch", id: branchId, reason: "branch does not match the branch-scoped API key" }] },
      { status: 403 }
    );
  }

  // ------------------------------------------------------------ validation
  const validBranches: BranchInput[] = [];
  for (const b of rawBranches) {
    const id = asId(b?.id);
    const name = asText(b?.name);
    if (!id) { details.push({ entity: "branch", id: null, reason: "branch id is required" }); continue; }
    if (!name) { details.push({ entity: "branch", id, reason: "branch name is required" }); continue; }
    if (id !== branchId) { details.push({ entity: "branch", id, reason: `branch ${id} does not belong to the synchronized branch ${branchId}` }); continue; }
    validBranches.push({
      id,
      name,
      description: asText(b?.description),
      location: asText(b?.location),
      enabled: asBool(b?.enabled, true),
    });
  }

  const validDestinations: DestinationInput[] = [];
  for (const d of rawDestinations) {
    const id = asId(d?.id);
    const dBranch = asId(d?.branchId ?? d?.branch_id);
    const name = asText(d?.name);
    const type = asText(d?.type ?? d?.destination_type);
    if (!id) { details.push({ entity: "destination", id: null, reason: "destination id is required" }); continue; }
    if (!name) { details.push({ entity: "destination", id, reason: "destination name is required" }); continue; }
    if (!type) { details.push({ entity: "destination", id, reason: "destination type is required" }); continue; }
    if (!dBranch) { details.push({ entity: "destination", id, reason: "destination branchId is required" }); continue; }
    if (dBranch !== branchId) {
      details.push({ entity: "destination", id, branchId: dBranch, reason: `destination belongs to branch ${dBranch}, not to the synchronized branch ${branchId}` });
      continue;
    }
    validDestinations.push({
      id,
      branchId: dBranch,
      name,
      type,
      description: asText(d?.description),
      zone: asText(d?.zone),
      enabled: asBool(d?.enabled, true),
    });
  }

  const validDocumentTypes: DocumentTypeInput[] = [];
  for (const d of rawDocumentTypes) {
    const id = asId(d?.id);
    const dBranch = asId(d?.branchId ?? d?.branch_id);
    const name = asText(d?.name);
    const payloadHint = asText(d?.payloadHint ?? d?.payload_hint);
    if (!id) { details.push({ entity: "documentType", id: null, reason: "document type id is required" }); continue; }
    if (!name) { details.push({ entity: "documentType", id, reason: "document type name is required" }); continue; }
    if (!dBranch) { details.push({ entity: "documentType", id, reason: "document type branchId is required" }); continue; }
    if (dBranch !== branchId) {
      details.push({ entity: "documentType", id, branchId: dBranch, reason: `document type belongs to branch ${dBranch}, not to the synchronized branch ${branchId}` });
      continue;
    }
    if (payloadHint !== null && !['raw', 'escpos', 'pdf'].includes(payloadHint.toLowerCase())) {
      details.push({ entity: "documentType", id, reason: `unsupported payloadHint ${payloadHint}; expected raw, escpos, or pdf` });
      continue;
    }
    validDocumentTypes.push({
      id,
      branchId: dBranch,
      name,
      description: asText(d?.description),
      payloadHint: payloadHint ? payloadHint.toLowerCase() : null,
      enabled: asBool(d?.enabled, true),
    });
  }

  const validBindings: BindingInput[] = [];
  for (const b of rawBindings) {
    const id = asId(b?.id);
    const bBranch = asId(b?.branchId ?? b?.branch_id);
    const destinationId = asId(b?.destinationId ?? b?.destination_id);
    const printerId = asId(b?.printerId ?? b?.printer_id);
    if (!id) { details.push({ entity: "binding", id: null, reason: "binding id is required" }); continue; }
    if (!bBranch) { details.push({ entity: "binding", id, reason: "binding branchId is required" }); continue; }
    if (!destinationId) { details.push({ entity: "binding", id, reason: "binding destinationId is required" }); continue; }
    if (!printerId) { details.push({ entity: "binding", id, reason: "binding printerId is required" }); continue; }
    if (bBranch !== branchId) {
      details.push({ entity: "binding", bindingId: id, id, branchId: bBranch, reason: `binding belongs to branch ${bBranch}, not to the synchronized branch ${branchId}` });
      continue;
    }
    const priority = typeof b?.priority === "number" && Number.isFinite(b.priority) ? Math.trunc(b.priority) : 1;
    validBindings.push({
      id,
      branchId: bBranch,
      destinationId,
      documentType: asText(b?.documentType ?? b?.document_type),
      printerId,
      priority,
      enabled: asBool(b?.enabled, true),
    });
  }

  // ------------------------------------------------- cross-reference checks
  // These read the current database state; nothing has been written yet.
  const missingDependencies: Detail[] = [];
  const hasDestinations = Array.isArray(body.destinations);
  const hasDocumentTypes = Array.isArray(body.documentTypes) || Array.isArray(body.document_types);
  const hasBindings = Array.isArray(body.bindings);
  try {
    const referencedDestinationIds = [...new Set(validBindings.map((b) => b.destinationId))];
    const payloadDestinationIds = new Set(validDestinations.map((d) => d.id));
    const unknownDestinationIds = referencedDestinationIds.filter((id) => !payloadDestinationIds.has(id));

    const existingDestinations = unknownDestinationIds.length
      ? await db.select({ id: destinations.id, branchId: destinations.branchId }).from(destinations).where(inArray(destinations.id, unknownDestinationIds))
      : [];
    const existingDestinationById = new Map(existingDestinations.map((d) => [asId(d.id)!, asId(d.branchId)]));

    const referencedPrinterIds = [...new Set(validBindings.map((b) => b.printerId))];
    const existingPrinters = referencedPrinterIds.length
      ? await db.select({ id: printers.id, branchId: agents.branchId }).from(printers).innerJoin(agents, eq(agents.id, printers.agentId)).where(inArray(printers.id, referencedPrinterIds))
      : [];
    const printerBranchById = new Map(existingPrinters.map((p) => [asId(p.id)!, asId(p.branchId)]));

    // Cross-branch primary-key collision: destination/document-type/binding
    // ids are globally unique. Re-using an id that already belongs to another
    // branch would silently steal the row on ON CONFLICT DO UPDATE.
    if (validDestinations.length > 0) {
      const destIds = validDestinations.map((d) => d.id);
      const existing = await db.select({ id: destinations.id, branchId: destinations.branchId }).from(destinations).where(inArray(destinations.id, destIds));
      for (const row of existing) {
        const id = asId(row.id)!;
        const owner = asId(row.branchId);
        if (owner && owner !== branchId) {
          details.push({ entity: "destination", id, branchId: owner, reason: `destination id ${id} already belongs to branch ${owner}; cross-branch id reuse is not allowed` });
        }
      }
    }
    if (validDocumentTypes.length > 0) {
      const dtIds = validDocumentTypes.map((d) => d.id);
      const existing = await db.select({ id: documentTypes.id, branchId: documentTypes.branchId }).from(documentTypes).where(inArray(documentTypes.id, dtIds));
      for (const row of existing) {
        const id = asId(row.id)!;
        const owner = asId(row.branchId);
        if (owner && owner !== branchId) {
          details.push({ entity: "documentType", id, branchId: owner, reason: `document type id ${id} already belongs to branch ${owner}; cross-branch id reuse is not allowed` });
        }
      }
    }
    if (validBindings.length > 0) {
      const bindingIds = validBindings.map((b) => b.id);
      const existing = await db.select({ id: printerBindings.id, branchId: printerBindings.branchId }).from(printerBindings).where(inArray(printerBindings.id, bindingIds));
      for (const row of existing) {
        const id = asId(row.id)!;
        const owner = asId(row.branchId);
        if (owner && owner !== branchId) {
          details.push({ entity: "binding", id, bindingId: id, branchId: owner, reason: `binding id ${id} already belongs to branch ${owner}; cross-branch id reuse is not allowed` });
        }
      }
    }

    for (const b of validBindings) {
      if (!payloadDestinationIds.has(b.destinationId)) {
        const destBranch = existingDestinationById.get(b.destinationId);
        if (destBranch === undefined) {
          missingDependencies.push({
            entity: "binding",
            id: b.id,
            bindingId: b.id,
            destinationId: b.destinationId,
            reason: "destination does not exist in the gateway and is not part of this sync",
          });
          continue;
        }
        if (destBranch !== branchId) {
          details.push({
            entity: "binding",
            id: b.id,
            bindingId: b.id,
            destinationId: b.destinationId,
            reason: `destination belongs to branch ${destBranch}, not to the synchronized branch ${branchId}`,
          });
          continue;
        }
      }

      const printerBranch = printerBranchById.get(b.printerId);
      if (printerBranch === undefined) {
        missingDependencies.push({
          entity: "binding",
          id: b.id,
          bindingId: b.id,
          printerId: b.printerId,
          reason: "printer does not exist in the gateway yet — printers are registered by agents, retry the sync after the agent reports it",
        });
        continue;
      }
      if (printerBranch !== branchId) {
        details.push({
          entity: "binding",
          id: b.id,
          bindingId: b.id,
          printerId: b.printerId,
          reason: `printer belongs to branch ${printerBranch ?? "none"}, not to the synchronized branch ${branchId}`,
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "odoo.sync.dependency_validation_failed", error: msg.slice(0, 500) }));
    return NextResponse.json({ success: false, error: "SYNC_INTERNAL_ERROR", message: "database error while validating sync dependencies" }, { status: 500 });
  }

  if (details.length > 0) {
    return NextResponse.json({ success: false, error: "SYNC_VALIDATION_FAILED", branchId, details }, { status: 400 });
  }
  if (missingDependencies.length > 0) {
    return NextResponse.json({ success: false, error: "SYNC_DEPENDENCY_MISSING", branchId, details: missingDependencies }, { status: 400 });
  }

  // ------------------------------------------------------------ apply (1 tx)
  // Order matters: branches → destinations → document types → bindings, so
  // foreign keys are always satisfied inside the transaction. Any failure
  // rolls the whole sync back; a half-synced gateway is never reported as
  // success.
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      for (const b of validBranches) {
        await tx.insert(branches)
          .values({ id: b.id, name: b.name, description: b.description, location: b.location, enabled: b.enabled })
          .onConflictDoUpdate({
            target: branches.id,
            set: { name: b.name, description: b.description, location: b.location, enabled: b.enabled, updatedAt: now },
          });
      }

      for (const d of validDestinations) {
        await tx.insert(destinations)
          .values({ id: d.id, branchId: d.branchId, name: d.name, type: d.type, description: d.description, zone: d.zone, enabled: d.enabled })
          .onConflictDoUpdate({
            target: destinations.id,
            set: { branchId: d.branchId, name: d.name, type: d.type, description: d.description, zone: d.zone, enabled: d.enabled, updatedAt: now },
          });
      }

      for (const d of validDocumentTypes) {
        await tx.insert(documentTypes)
          .values({ id: d.id, branchId: d.branchId, name: d.name, description: d.description, payloadHint: d.payloadHint, enabled: d.enabled })
          .onConflictDoUpdate({
            target: documentTypes.id,
            set: { branchId: d.branchId, name: d.name, description: d.description, payloadHint: d.payloadHint, enabled: d.enabled, updatedAt: now },
          });
      }

      for (const b of validBindings) {
        await tx.insert(printerBindings)
          .values({
            id: b.id,
            branchId: b.branchId,
            destinationId: b.destinationId,
            documentType: b.documentType,
            printerId: b.printerId,
            priority: b.priority,
            enabled: b.enabled,
          })
          .onConflictDoUpdate({
            target: printerBindings.id,
            set: {
              branchId: b.branchId,
              destinationId: b.destinationId,
              documentType: b.documentType,
              printerId: b.printerId,
              priority: b.priority,
              enabled: b.enabled,
              updatedAt: now,
            },
          });
      }

      // Full-snapshot reconciliation for collections present in the payload.
      // Resources omitted from an explicit array are disabled (not deleted,
      // so historical print_jobs keep their FKs) and stay in this branch.
      // Printers and agents are gateway-owned and are never disabled here.
      if (hasDestinations) {
        const keep = validDestinations.map((d) => d.id);
        const where = keep.length === 0
          ? eq(destinations.branchId, branchId)
          : and(eq(destinations.branchId, branchId), notInArray(destinations.id, keep));
        await tx.update(destinations).set({ enabled: false, updatedAt: now }).where(where);
      }
      if (hasDocumentTypes) {
        const keep = validDocumentTypes.map((d) => d.id);
        const where = keep.length === 0
          ? eq(documentTypes.branchId, branchId)
          : and(eq(documentTypes.branchId, branchId), notInArray(documentTypes.id, keep));
        await tx.update(documentTypes).set({ enabled: false, updatedAt: now }).where(where);
      }
      if (hasBindings) {
        const keep = validBindings.map((b) => b.id);
        const where = keep.length === 0
          ? eq(printerBindings.branchId, branchId)
          : and(eq(printerBindings.branchId, branchId), notInArray(printerBindings.id, keep));
        await tx.update(printerBindings).set({ enabled: false, updatedAt: now }).where(where);
      }
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown database error";
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "odoo.sync.transaction_rolled_back", error: message.slice(0, 500) }));
    return NextResponse.json(
      { success: false, error: "SYNC_INTERNAL_ERROR", branchId, message: `synchronization rolled back: ${message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    branchId,
    synced: {
      branches: validBranches.length,
      destinations: validDestinations.length,
      documentTypes: validDocumentTypes.length,
      bindings: validBindings.length,
    },
    branches: validBranches.map((b) => ({ id: b.id, action: "upserted" })),
    destinations: validDestinations.map((d) => ({ id: d.id, action: "upserted" })),
    documentTypes: validDocumentTypes.map((d) => ({ id: d.id, action: "upserted" })),
    bindings: validBindings.map((b) => ({ id: b.id, action: "upserted" })),
  });
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
      const rows = await db.select({ printer: printers, branchId: agents.branchId }).from(printers).innerJoin(agents, eq(agents.id, printers.agentId)).where(eq(agents.branchId, branchFilter)).orderBy(desc(printers.updatedAt)).limit(100);
      printerRows = rows.map(({ printer, branchId }) => ({ ...printer, branchId }));
      jobRows = await db.select().from(printJobs).where(eq(printJobs.branchId, branchFilter)).orderBy(desc(printJobs.createdAt)).limit(50);
    } else {
      agentRows = await db.select().from(agents).orderBy(desc(agents.lastSeenAt)).limit(20);
      const rows = await db.select({ printer: printers, branchId: agents.branchId }).from(printers).innerJoin(agents, eq(agents.id, printers.agentId)).orderBy(desc(printers.updatedAt)).limit(20);
      printerRows = rows.map(({ printer, branchId }) => ({ ...printer, branchId }));
      jobRows = await db.select().from(printJobs).orderBy(desc(printJobs.createdAt)).limit(20);
    }
  } catch (e) {
    // Do not mask DB failures as an empty-but-successful status payload;
    // Odoo would wrongly conclude "nothing changed" instead of retrying.
    return NextResponse.json({ error: "database error while loading sync status" }, { status: 500 });
  }

  // Strip secrets
  const safeAgents = agentRows.map((a: any) => {
    const { secret, pairingCode, ...rest } = a;
    return rest;
  });

  return NextResponse.json({ branchId: branchFilter, agents: safeAgents, printers: printerRows, jobs: jobRows, syncStatus: "success" });
}
