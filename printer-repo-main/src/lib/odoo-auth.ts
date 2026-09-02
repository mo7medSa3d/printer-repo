import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function generateOdooApiKey(): { raw: string; hashed: string; id: string } {
  const raw = `odoo_${randomBytes(24).toString("base64url")}`;
  const hashed = hashKey(raw);
  // id is hash prefix for lookup without scanning full table via hash
  const id = `key_${randomBytes(6).toString("hex")}`;
  return { raw, hashed, id };
}

export function hashOdooKey(raw: string): string {
  return hashKey(raw);
}

/**
 * Odoo authenticates via Authorization: Bearer odoo_xxx  or  X-Api-Key: odoo_xxx
 * Separate from agent Bearer agt:secret. Never logs raw key.
 *
 * The Odoo addon historically sent Odoo record ids (ints) as branchId; the
 * Gateway stores ids as text and compares them. Normalize both sides to
 * strings so a scoped key still matches (no int/char drift breaking auth).
 */
export function isBranchScopedKeyAllowed(keyBranchId: string | null | undefined, expectedBranchId?: string | null): boolean {
  if (!expectedBranchId) return true;
  return !keyBranchId || String(keyBranchId) === String(expectedBranchId);
}

/**
 * Document types are matched case-insensitively and whitespace-insensitively,
 * exactly like the routing layer (`selectBestBinding` in src/lib/routing.ts
 * lower-cases both sides). Odoo sends document types derived from user-visible
 * names ("Invoice"), while allow-lists are usually typed in lower case, so a
 * case-sensitive comparison here rejected legitimate jobs with 403 while
 * routing considered the very same value a match.
 */
function normalizeDocumentType(value: string): string {
  return value.trim().toLowerCase();
}

export function isOdooKeyAllowedForDocumentType(
  key: { allowedDocumentTypes?: string[] | null; scope?: string | null },
  documentType?: string | null,
  operation: "read" | "write" = "read"
): boolean {
  if (key.scope === "read_only" && operation === "write") return false;
  if (!key.allowedDocumentTypes || key.allowedDocumentTypes.length === 0) return true;
  if (!documentType) return true;
  const requested = normalizeDocumentType(documentType);
  if (!requested) return true;
  return key.allowedDocumentTypes
    .filter((entry): entry is string => typeof entry === "string")
    .some((entry) => normalizeDocumentType(entry) === requested);
}

export async function validateOdooKey(req: Request, expectedBranchId?: string | null) {
  const auth = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  let raw = "";
  if (auth.startsWith("Bearer ")) raw = auth.slice(7).trim();
  else if (auth) raw = auth.trim();
  else {
    const h2 = req.headers.get("x-api-key");
    if (h2) raw = h2.trim();
  }
  if (!raw || !raw.startsWith("odoo_")) return null;
  const hashed = hashKey(raw);
  const row = await db.query.apiKeys.findFirst({ where: eq(apiKeys.hashedKey, hashed) });
  if (!row || row.revokedAt) return null;
  if (!isBranchScopedKeyAllowed(row.branchId, expectedBranchId)) return null;
  if (!timingSafeEqualStr(row.hashedKey, hashed)) return null;
  db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).then(() => {}).catch(() => {});
  return row;
}
