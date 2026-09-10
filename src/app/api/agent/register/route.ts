import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { agents } from "../../../../db/schema";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { generateSecret, hashPairingCode, hashSecret, isValidPairingCode } from "../../../../lib/agent-auth";
import {
  clientIpFrom,
  inspectPairingRateLimit,
  recordPairingFailure,
  recordPairingSuccess,
} from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_REGISTRATION_BODY_BYTES = 64 * 1024;

const registrationSchema = z.object({
  pairingCode: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  pairing_code: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  hostname: z.string().trim().max(255).optional(),
  client_version: z.string().trim().max(100).optional(),
  clientVersion: z.string().trim().max(100).optional(),
  platform: z.string().trim().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().trim().min(1).max(120).optional(),
  agent_id: z.string().trim().min(1).max(120).optional(),
}).strict().refine((data) => Boolean(data.pairingCode || data.pairing_code), {
  message: "pairing_code or pairingCode is required",
}).refine((data) => {
  if (data.pairingCode && data.pairing_code && data.pairingCode.toUpperCase() !== data.pairing_code.toUpperCase()) {
    return false;
  }
  if (data.agentId && data.agent_id && data.agentId !== data.agent_id) {
    return false;
  }
  if (data.clientVersion && data.client_version && data.clientVersion !== data.client_version) {
    return false;
  }
  return true;
}, {
  message: "Conflicting alias fields provided",
});

export async function POST(req: Request) {
  try {
    if (hasBodyOverLimit(req, MAX_REGISTRATION_BODY_BYTES)) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (body && typeof body === "object" && "metadata" in body) {
      const metaObj = (body as { metadata?: unknown }).metadata;
      if (metaObj && JSON.stringify(metaObj).length > 32_768) {
        return NextResponse.json({ error: "metadata exceeds 32KB" }, { status: 400 });
      }
    }

    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        error: parsed.error.issues[0]?.message ?? "pairingCode must be exactly 6 characters from the approved alphabet",
      }, { status: 400 });
    }

    const rawCode = (parsed.data.pairing_code || parsed.data.pairingCode)!;
    const normalizedCode = rawCode.trim().toUpperCase();
    const hashedCode = hashPairingCode(normalizedCode);
    const ip = clientIpFrom(req);

    try {
      const decision = await inspectPairingRateLimit(ip);
      if (!decision.allowed) {
        const response = NextResponse.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
    } catch {
      return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
    }

    const targetAgentId = parsed.data.agent_id || parsed.data.agentId;
    const conditions = [
      eq(agents.pairingCodeHash, hashedCode),
      isNotNull(agents.pairingCodeHash),
      gt(agents.pairingCodeExpiresAt, new Date()),
      eq(agents.lifecycle, "active"),
    ];
    if (targetAgentId) conditions.push(eq(agents.id, targetAgentId));

    const agent = await db.query.agents.findFirst({ where: and(...conditions) });
    if (!agent) {
      try { await recordPairingFailure(ip); } catch {}
      return NextResponse.json({ error: "Unknown, disabled, retired, or expired agent registration" }, { status: 400 });
    }

    const meta: Record<string, unknown> = {
      ...(agent.metadata ?? {}),
      ...(parsed.data.metadata ?? {}),
      ...(parsed.data.hostname ? { hostname: parsed.data.hostname } : {}),
      ...(parsed.data.client_version || parsed.data.clientVersion ? { version: parsed.data.client_version || parsed.data.clientVersion } : {}),
      ...(parsed.data.platform ? { os: parsed.data.platform } : {}),
    };

    const secret = generateSecret();
    const now = new Date();
    const updated = await db.update(agents).set({
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      secret: hashSecret(secret),
      status: "online",
      metadata: meta,
      lastSeenAt: now,
      updatedAt: now,
    }).where(and(
      eq(agents.id, agent.id),
      eq(agents.pairingCodeHash, hashedCode),
      eq(agents.lifecycle, "active"),
      gt(agents.pairingCodeExpiresAt, now),
    )).returning({ id: agents.id });

    if (!updated.length) {
      try { await recordPairingFailure(ip); } catch {}
      return NextResponse.json({ error: "Pairing code was consumed or expired; retry with a fresh code" }, { status: 409 });
    }

    try { await recordPairingSuccess(ip); } catch {}
    return NextResponse.json({
      agentId: agent.id,
      agent_id: agent.id,
      secret,
      agent_secret: secret,
    }, { status: 200 });
  } catch (error) {
    console.error("[agent/register] registration failed", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
