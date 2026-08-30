import { db } from "@/db";
import { managerSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const COOKIE_NAME = "mgr_session";
const MAX_AGE_SECONDS = 8 * 60 * 60; // 8h

function getSecret(): string {
  const s = process.env.GATEWAY_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error("GATEWAY_JWT_SECRET must be set to >=32 chars");
  }
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
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = createHmac("sha256", getSecret()).update(data).digest("base64url");
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as ManagerClaims;
    if (claims.sub !== "manager" || typeof claims.jti !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function getManagerCookieName() {
  return COOKIE_NAME;
}

export async function createManagerSession(): Promise<{ token: string; jti: string; exp: Date }> {
  const jti = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + MAX_AGE_SECONDS;
  const claims: ManagerClaims = { jti, iat: now, exp, sub: "manager" };
  const token = sign(claims);
  await db.insert(managerSessions).values({
    jti,
    expiresAt: new Date(exp * 1000),
  });
  return { token, jti, exp: new Date(exp * 1000) };
}

export async function validateManager(req: Request): Promise<ManagerClaims | null> {
  // Prefer httpOnly cookie, fallback to Authorization: Bearer mgr_...
  // Cookie header may contain multiple cookies; extract mgr_session
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
  if (!claims) return null;
  const row = await db.query.managerSessions.findFirst({ where: eq(managerSessions.jti, claims.jti) });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return claims;
}

export async function revokeManagerSession(jti: string) {
  await db.update(managerSessions).set({ revokedAt: new Date() }).where(eq(managerSessions.jti, jti));
}

export function managerCookieHeader(token: string, exp: Date): string {
  // httpOnly, Secure in prod, SameSite Lax, Path /
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${exp.toUTCString()}; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearManagerCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

function hashPasswordScrypt(pw: string): string {
  const { scryptSync, randomBytes: rb } = require("crypto") as typeof import("crypto");
  const salt = rb(16).toString("hex");
  const derived = scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyManagerPassword(username: string, input: string): boolean {
  const expectedUser = process.env.MANAGER_USERNAME;
  const expectedHash = process.env.MANAGER_PASSWORD_HASH; // scrypt salt:derived
  const expectedPass = process.env.MANAGER_PASSWORD;
  if (!expectedUser) return false;
  // username check timing-safe
  const ub = Buffer.from(username);
  const eb = Buffer.from(expectedUser);
  const userOk = ub.length === eb.length && timingSafeEqual(ub, eb);
  if (!userOk) {
    // still do work to avoid timing leak on password
    if (expectedHash?.includes(":")) {
      const { scryptSync } = require("crypto") as typeof import("crypto");
      scryptSync(input, "0000000000000000", 32);
    }
    return false;
  }
  if (expectedHash && expectedHash.includes(":")) {
    const { scryptSync, timingSafeEqual: tse } = require("crypto") as typeof import("crypto");
    const [salt, hash] = expectedHash.split(":");
    const derived = scryptSync(input, salt, 32).toString("hex");
    if (derived.length !== hash.length) return false;
    return tse(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
  }
  if (expectedPass) {
    const a = Buffer.from(input);
    const b = Buffer.from(expectedPass);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  return false;
}

export function getManagerUsername(): string | null {
  return process.env.MANAGER_USERNAME ?? null;
}
