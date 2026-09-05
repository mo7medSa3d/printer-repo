import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { generateSecret, hashSecret } from "@/lib/agent-auth";
import {
  clientIpFrom,
  inspectAuthRateLimit,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/auth-rate-limit";
import { hasBodyOverLimit } from "@/lib/request-limits";
import { z } from "zod";

const MAX_REGISTRATION_BODY_BYTES = 64 * 1024;

const registrationSchema = z.object({
  pairingCode: z.string().trim().min(1).max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().trim().min(1).max(120).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    if (hasBodyOverLimit(req, MAX_REGISTRATION_BODY_BYTES)) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    const body = await req.json();
    if (body?.metadata && JSON.stringify(body.metadata).length > 32_768) {
      return NextResponse.json({ error: "metadata exceeds 32KB" }, { status: 400 });
    }

    if (body && typeof body === "object" && "branchId" in body) {
      return NextResponse.json({ error: "branchId is not accepted during registration" }, { status: 400 });
    }

    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "pairingCode is required" }, { status: 400 });
    }

    const normalizedCode = parsed.data.pairingCode.toUpperCase();
    const ip = clientIpFrom(req);
    const limiterUsername = parsed.data.agentId ?? `pairing:${normalizedCode}`;

    try {
      const decision = await inspectAuthRateLimit(ip, limiterUsername);
      if (!decision.allowed) {
        const response = NextResponse.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
    } catch {
      return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
    }

    const conditions = [
      eq(agents.pairingCode, normalizedCode),
      gt(agents.pairingCodeExpiresAt, new Date()),
      eq(agents.lifecycle, "active"),
    ];
    if (parsed.data.agentId) conditions.push(eq(agents.id, parsed.data.agentId));

    const agent = await db.query.agents.findFirst({ where: and(...conditions) });
    if (!agent) {
      try {
        await recordAuthFailure(ip, limiterUsername);
      } catch {
        // A failed rate-limit write must not reveal whether the pairing code was valid.
      }
      return NextResponse.json({ error: "Unknown, disabled, retired, or expired agent registration" }, { status: 400 });
    }

    const secret = generateSecret();
    const now = new Date();
    const updated = await db.update(agents).set({
      pairingCode: null,
      pairingCodeExpiresAt: null,
      secret: hashSecret(secret),
      status: "online",
      metadata: parsed.data.metadata ?? {},
      lastSeenAt: now,
      updatedAt: now,
    }).where(and(
      eq(agents.id, agent.id),
      eq(agents.pairingCode, normalizedCode),
      eq(agents.lifecycle, "active"),
      gt(agents.pairingCodeExpiresAt, now),
    )).returning({ id: agents.id });

    if (!updated.length) {
      return NextResponse.json({ error: "Pairing code was already used or expired" }, { status: 409 });
    }

    try {
      await recordAuthSuccess(limiterUsername);
    } catch {
      // Housekeeping only; successful registration must not fail because a security counter could not be cleared.
    }

    return NextResponse.json({ agentId: agent.id, branchId: agent.branchId, secret });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
