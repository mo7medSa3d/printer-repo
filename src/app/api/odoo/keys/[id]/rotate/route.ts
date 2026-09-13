import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../../db";
import { apiKeys } from "../../../../../../db/schema";
import { validateManager } from "../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../lib/authorization";
import { generateOdooApiKey } from "../../../../../../lib/odoo-auth";
import { writeAuditEvent } from "../../../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const manager = await validateManager(req);
  if (!manager) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    requireManagerPermission(manager, "integrations.manage");
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!id?.trim()) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const rotated = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id, name, description, scope, allowed_document_types, revoked_at
        FROM api_keys
        WHERE id = ${id} AND tenant_id = ${manager.tenantId}
        FOR UPDATE
      `);
      const old = locked.rows[0] as {
        id: string;
        name: string;
        description: string | null;
        scope: string;
        allowed_document_types: string[] | null;
        revoked_at: Date | null;
      } | undefined;
      if (!old) return { kind: "not_found" as const };
      if (old.revoked_at) return { kind: "revoked" as const };

      const { raw, hashed, id: newId } = generateOdooApiKey();
      await tx.insert(apiKeys).values({
        id: newId,
        tenantId: manager.tenantId,
        scope: old.scope,
        name: old.name,
        description: old.description,
        hashedKey: hashed,
        allowedDocumentTypes: old.allowed_document_types,
      });
      await tx.update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, old.id), eq(apiKeys.tenantId, manager.tenantId)));
      return { kind: "rotated" as const, oldId: old.id, newId, raw, name: old.name, scope: old.scope, allowedDocumentTypes: old.allowed_document_types };
    });

    if (rotated.kind === "not_found") return NextResponse.json({ error: "API key not found" }, { status: 404 });
    if (rotated.kind === "revoked") return NextResponse.json({ error: "Only an active API key can be rotated" }, { status: 409 });

    void writeAuditEvent({
      tenantId: manager.tenantId,
      actorType: manager.userId ? "user" : "system",
      actorId: manager.userId ?? "legacy-manager",
      action: "api_key.rotated",
      resourceType: "api_key",
      resourceId: rotated.newId,
      metadata: { replacedKeyId: rotated.oldId, scope: rotated.scope },
    }).catch(() => undefined);

    return NextResponse.json({
      id: rotated.newId,
      replacedKeyId: rotated.oldId,
      name: rotated.name,
      scope: rotated.scope,
      allowedDocumentTypes: rotated.allowedDocumentTypes,
      apiKey: rotated.raw,
      note: "Update the Odoo installation with this new key now. The previous key has been revoked and the raw key will never be shown again.",
    }, { status: 201 });
  } catch (error) {
    console.error("[odoo] API key rotation failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
