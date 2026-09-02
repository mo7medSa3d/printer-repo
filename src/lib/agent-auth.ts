import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * Agents authenticate with `Authorization: Bearer <agentId>:<secret>`.
 * The secret itself is high-entropy (24 random bytes, base64url-encoded),
 * generated once at pairing time and never shown again, so a fast SHA-256 hash is
 * sufficient here (this is not a low-entropy human password that needs
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

/** Cryptographically secure pairing code (not Math.random()). */
export function generatePairingCode(): string {
  // 6 chars from an unambiguous alphabet (no 0/O/1/I), ~31 bits of entropy.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let code = "";
  for (const b of bytes) {
    code += alphabet[b % alphabet.length];
  }
  return code;
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

  // A retired agent has its secret revoked (set to NULL), so this alone already
  // fails closed. The explicit status check below is defence in depth: it also
  // stops a DISABLED agent, whose credential is intentionally still valid so it
  // can be re-enabled without re-pairing.
  if (!agent || !agent.secret) return null;

  const providedHash = hashSecret(secret);
  if (!timingSafeStringEqual(agent.secret, providedHash)) {
    return null;
  }

  // Lifecycle gate. A disabled or retired agent must not poll, heartbeat,
  // claim or complete jobs — it is out of service, and its printers have been
  // disabled to match.
  if (agent.status === "disabled" || agent.status === "retired") {
    return null;
  }

  return agent;
}
