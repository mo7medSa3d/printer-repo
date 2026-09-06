import { db } from "../db";
import { apiKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const ODOO_API_KEY_SCOPES = ["standard", "read_only"] as const;
export type OdooApiKeyScope = (typeof ODOO_API_KEY_SCOPES)[number];

/** Native Odoo company/branch identifiers accepted by the Gateway. */
export const ODOO_BRANCH_ID_RE = /^odoo_company_[1-9][0-9]*$/;

export function isNativeOdooBranchId(value: string | null | undefined): boolean {
  return typeof value === "string" && ODOO_BRANCH_ID_RE.test(value.trim());
}

/**
 * Supported tenancy model: one Odoo database per Gateway installation.
 * A production Gateway must bind Odoo API calls to this exact database name.
 */
export function configuredOdooDatabaseName(): string | null {
  const value = process.env.ODOO_DATABASE_NAME?.trim();
  if (!value || value.length > 63 || /[\r\n]/.test(value)) return null;
  return value;
}

export function isOdooDatabaseAllowed(requestDatabase: string | null | undefined): boolean {
  const configured = configuredOdooDatabaseName();
  if (!configured) return process.env.NODE_ENV !== "production";
  return typeof requestDatabase === "string" && requestDatabase.trim() === configured;
}

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
  const id = `key_${randomBytes(6).toString("hex")}`;
  return { raw, hashed, id };
}

export function hashOdooKey(raw: string): string {
  return hashKey(raw);
}

/** Branch-scoped keys may only authorize the exact native Odoo scope. */
export function isBranchScopedKeyAllowed(keyBranchId: string | null | undefined, expectedBranchId?: string | null): boolean {
  if (expectedBranchId && !isNativeOdooBranchId(String(expectedBranchId))) return false;
  if (keyBranchId && !isNativeOdooBranchId(String(keyBranchId))) return false;
  if (!expectedBranchId) return true;
  return !keyBranchId || String(keyBranchId) === String(expectedBranchId);
}

function normalizeDocumentType(value: string): string {
  return value.trim().toLowerCase();
}

export function isOdooKeyAllowedForDocumentType(
  key: { allowedDocumentTypes?: string[] | null; scope?: string | null },
  documentType?: string | null,
  operation: "read" | "write" = "read"
): boolean {
  if (key.scope !== undefined && key.scope !== null && !ODOO_API_KEY_SCOPES.includes(key.scope as OdooApiKeyScope)) return false;
  if (key.scope === "read_only" && operation === "write") return false;
  if (!key.allowedDocumentTypes || key.allowedDocumentTypes.length === 0) return true;
  if (!documentType) return true;
  const requested = normalizeDocumentType(documentType);
  if (!requested) return true;
  return key.allowedDocumentTypes
    .filter((entry): entry is string => typeof entry === "string")
    .some((entry) => normalizeDocumentType(entry) === requested);
}

export async function validateOdooKey(
  req: Request,
  expectedBranchId?: string | null,
  operation?: "read" | "write"
) {
  // Tenant binding is checked before credential lookup so a request from an
  // unbound Odoo database cannot probe the key space of this Gateway.
  const requestDatabase = req.headers.get("x-odoo-database");
  if (!isOdooDatabaseAllowed(requestDatabase)) return null;

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

  // GET/HEAD/OPTIONS are reads; every other HTTP method is potentially mutating.
  // Callers may explicitly override this when an endpoint has unusual semantics.
  const effectiveOperation = operation ?? (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase()) ? "read" : "write");
  if (!isOdooKeyAllowedForDocumentType(row, undefined, effectiveOperation)) return null;

  if (!timingSafeEqualStr(row.hashedKey, hashed)) return null;
  db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).then(() => {}).catch(() => {});
  return row;
}
