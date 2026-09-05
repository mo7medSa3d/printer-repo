import { db } from "../db";
import { agents } from "../db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";

/**
 * Agents authenticate with `Authorization: Bearer <agentId>:<secret>`.
 * The secret itself is high-entropy (24 random bytes, base64url-encoded),
 * generated once at pairing time and never shown again, so a fast SHA-256 hash
 * is sufficient here (this is not a low-entropy human password that needs
 * bcrypt/scrypt-style slow hashing) - and it avoids adding a new
 * dependency. Only the hash is ever stored; the plaintext secret exists
 * only in the single pairing response and in the agent's local config.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateSecret(): string {
  return randomBytes(24).toString("base64url");
}

/** Cryptographically secure six-digit numeric pairing code. */
export function generatePairingCode(): string {
  // Keep the public pairing contract exactly six decimal digits, including
  // leading zeroes. randomInt() uses the OS CSPRNG and avoids modulo bias.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers to avoid a fast
    // early-return based on length leaking information.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function validateAgent(authHeader: string | null) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length);
  const separatorIndex = token.indexOf(":");
  if (separatorIndex === -1) return null;

  const agentId = token.slice(0, separatorIndex);
  const secret = token.slice(separatorIndex + 1);
  if (!agentId || !secret) return null;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent || !agent.secret || agent.lifecycle !== "active") return null;

  const providedHash = hashSecret(secret);
  if (!timingSafeStringEqual(agent.secret, providedHash)) {
    return null;
  }

  return agent;
}
