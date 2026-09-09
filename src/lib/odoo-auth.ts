import { db } from "../db";
import { apiKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

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
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateOdooApiKey(): { raw: string; hashed: string; id: string } {
  const raw = `odoo_${randomBytes(32).toString("base64url")}`;
  return { raw, hashed: hashKey(raw), id: `key_${randomBytes(8).toString("hex")}` };
}

function normalizeDocumentType(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isOdooKeyAllowedForDocumentType(
  key: { allowedDocumentTypes?: string[] | null; scope?: string | null },
  documentType?: string | null,
  operation: "read" | "write" = "read",
): boolean {
  if (operation === "write" && String(key.scope ?? "standard").trim().toLowerCase() === "read_only") {
    return false;
  }
  const allowed = key.allowedDocumentTypes;
  if (!allowed || allowed.length === 0) return true;
  const normalized = normalizeDocumentType(documentType);
  if (!normalized) return false;
  return allowed.some((value) => normalizeDocumentType(value) === normalized);
}

export async function validateOdooKey(req: Request) {
  const requestDatabase = req.headers.get("x-odoo-database");
  if (!isOdooDatabaseAllowed(requestDatabase)) return null;

  const authorization = req.headers.get("authorization") ?? "";
  const apiHeader = req.headers.get("x-api-key") ?? "";
  const raw = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : apiHeader.trim();
  if (!raw.startsWith("odoo_")) return null;

  const hashed = hashKey(raw);
  const row = await db.query.apiKeys.findFirst({ where: eq(apiKeys.hashedKey, hashed) });
  if (!row || row.revokedAt || !timingSafeEqualStr(row.hashedKey, hashed)) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => undefined);
  return row;
}
