import { db } from "../db";
import { managerSessions } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { requiredRuntimeSecret, runtimeSecret } from "./runtime-secret";

const COOKIE_NAME = "mgr_session";
const MAX_AGE_SECONDS = 8 * 60 * 60;

function getSecret(): string {
  const s = requiredRuntimeSecret("GATEWAY_JWT_SECRET");
  if (s.length < 32) throw new Error("GATEWAY_JWT_SECRET must be >=32 chars");
  return s;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export type ManagerClaims = { jti: string; iat: number; exp: number; sub: "manager" };

function sign(claims: ManagerClaims): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", getSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verify(token: string): ManagerClaims | null {
  if (typeof token !== "string" || token.length < 40 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  try {
    const header = JSON.parse(b64urlDecode(h).toString("utf8")) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
  } catch {
    return null;
  }

  const data = `${h}.${p}`;
  const expected = createHmac("sha256", getSecret()).update(data).digest("base64url");
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Partial<ManagerClaims>;
    if (
      claims.sub !== "manager" ||
      typeof claims.jti !== "string" ||
      claims.jti.length < 16 ||
      claims.jti.length > 128 ||
      typeof claims.iat !== "number" ||
      !Number.isSafeInteger(claims.iat) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_AGE_SECONDS
    ) return null;
    if (claims.exp * 1000 <= Date.now()) return null;
    if (claims.iat * 1000 > Date.now() + 60_000) return null;
    return claims as ManagerClaims;
  } catch {
    return null;
  }
}

export function getManagerCookieName() {
  return COOKIE_NAME;
}

export function verifyManagerToken(token: string): ManagerClaims | null {
  return verify(token);
}

export async function validateManagerClaims(claims: ManagerClaims | null): Promise<ManagerClaims | null> {
  if (!claims) return null;
  const row = await db.query.managerSessions.findFirst({ where: eq(managerSessions.jti, claims.jti) });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return claims;
}

export async function createManagerSession(): Promise<{ token: string; jti: string; exp: Date }> {
  const jti = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MAX_AGE_SECONDS;
  const claims: ManagerClaims = { jti, iat: now, exp, sub: "manager" };
  const token = sign(claims);
  await db.insert(managerSessions).values({ jti, expiresAt: new Date(exp * 1000) });
  return { token, jti, exp: new Date(exp * 1000) };
}

export async function validateManager(req: Request): Promise<ManagerClaims | null> {
  let token: string | null = null;
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) {
      token = rest.join("=").trim();
      if (token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1);
      break;
    }
  }
  if (!token) {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) token = auth.slice(7).trim();
  }
  if (!token) return null;
  const claims = verify(token);
  return claims ? validateManagerClaims(claims) : null;
}

export async function revokeManagerSession(jti: string) {
  await db.update(managerSessions).set({ revokedAt: new Date() }).where(eq(managerSessions.jti, jti));
}

export async function cleanupExpiredManagerSessions(now = new Date()): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM manager_sessions
    WHERE expires_at <= ${now}
    RETURNING jti
  `);
  return result.rows.length;
}

function managerCookieSecure(): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function managerCookieHeader(token: string, exp: Date): string {
  const secure = managerCookieSecure() ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${exp.toUTCString()}; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearManagerCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

function compareStringsSafe(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyManagerPassword(username: string, input: string): boolean {
  const expectedUser = runtimeSecret("MANAGER_USERNAME");
  const expectedHash = runtimeSecret("MANAGER_PASSWORD_HASH");
  const expectedPass = runtimeSecret("MANAGER_PASSWORD");
  if (!expectedUser || typeof input !== "string") return false;

  const userOk = compareStringsSafe(username, expectedUser);
  if (!userOk) {
    if (expectedHash?.includes(":")) {
      const [salt] = expectedHash.split(":", 1);
      if (salt) scryptSync(input, salt, 32);
    }
    return false;
  }

  if (expectedHash && expectedHash.includes(":")) {
    const [salt, hash] = expectedHash.split(":");
    if (!salt || !hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return false;
    const derived = scryptSync(input, salt, 32).toString("hex");
    return compareStringsSafe(derived, hash.toLowerCase());
  }

  if (process.env.ALLOW_PLAINTEXT_MANAGER_PASSWORD !== "1" || !expectedPass) return false;
  return compareStringsSafe(input, expectedPass);
}

export function getManagerUsername(): string | null {
  return runtimeSecret("MANAGER_USERNAME") ?? null;
}
