import { db } from "../db";
import { auditEvents } from "../db/schema";
import { nanoid } from "nanoid";

export type AuditActor = "user" | "odoo" | "agent" | "desktop" | "system" | "platform";

const SECRET_KEYS = /password|secret|token|authorization|cookie|api[_-]?key|payload|pairing/i;

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof entry === "string" && entry.length > 500) {
      out[key] = `${entry.slice(0, 200)}…(${entry.length} chars)`;
    } else if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

export async function writeAuditEvent(input: {
  tenantId: string;
  actorType: AuditActor;
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditEvents).values({
    id: `audit_${nanoid(14)}`,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    requestId: input.requestId ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}
