import { db } from "../db";
import { agents } from "../db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

/** Public registration contract: exactly six decimal digits, including leading zeroes. */
export const PAIRING_CODE_PATTERN = /^\d{6}$/;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function isValidPairingCode(value: unknown): value is string {
  return typeof value === "string" && PAIRING_CODE_PATTERN.test(value.trim());
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function validateAgent(authHeader: string | null) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  const separatorIndex = token.indexOf(":");
  if (separatorIndex === -1) return null;

  const agentId = token.slice(0, separatorIndex);
  const secret = token.slice(separatorIndex + 1);
  if (!agentId || !secret) return null;

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || !agent.secret || agent.lifecycle !== "active") return null;

  const providedHash = hashSecret(secret);
  if (!timingSafeStringEqual(agent.secret, providedHash)) return null;
  return agent;
}
