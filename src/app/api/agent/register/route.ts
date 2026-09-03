import { NextResponse } from "next/server";
import { agents } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse as Response } from "next/server";
import { generateSecret, hashSecret } from "@/lib/agent-auth";
import {
  clientIpFrom,
  inspectAuthRateLimit,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/auth-rate-limit";
import { z } from "zod";

const registrationSchema = z.object({
  // The pairing code is the one-time credential. Agent identity/branch are
  // derived from the pre-provisioned Gateway record instead of trusting a
  // client-supplied branch.
  pairingCode: z.string().trim().min(1).max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Optional compatibility hint. When present it must match the agent bound
  // to the pairing code, but it is never required for a valid registration.
  agentId: z.string().trim().min(1).max(120).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body?.metadata && JSON.stringify(body.metadata).length > 32_768) {
      return Response.json({ error: "metadata exceeds 32KB" }, { status: 400 });
    }

    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "pairingCode is required; branchId is not accepted" }, { status: 400 });
    }

    if (body && typeof body === "object" && "branchId" in body) {
      return Response.json({ error: "branchId is not accepted during registration" }, { status: 400 });
    }

    const normalizedCode = parsed.data.pairingCode.toUpperCase();
    const ip = clientIpFrom(req);
    const limiterUsername = parsed.data.agentId ?? `pairing:${normalizedCode}`;

    try {
      const decision = await inspectAuthRateLimit(ip, limiterUsername);
      if (!decision.allowed) {
        const response = Response.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
    } catch {
      return Response.json({ error: "Registration temporarily unavailable" }, { status: 503 });
    }

    const conditions = [
      eq(agents.pairingCode, normalizedCode),
      gt(agents.pairingCodeExpiresAt, new Date()),
      eq(agents.lifecycle, "active"),
    ];
    if (parsed.data.agentId) {
      conditions.push(eq(agents.id, parsed.data.agentId));
    }

    const agent = await db.query.agents.findFirst({ where: and(...conditions) });
    if (!agent) {
      try {
        await recordAuthFailure(ip, limiterUsername);
      } catch {
        // A failed rate-limit write must not reveal whether the pairing code was valid.
      }
      return Response.json({ error: "Unknown, disabled, retired, or expired agent registration" }, { status: 400 });
    }

    const secret = generateSecret();
    const updated = await db.update(agents).set({
      pairingCode: null,
      pairingCodeExpiresAt: null,
      secret: hashSecret(secret),
      status: "online",
      metadata: parsed.data.metadata ?? {},
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(agents.id, agent.id),
      eq(agents.pairingCode, normalizedCode),
      eq(agents.lifecycle, "active"),
      gt(agents.pairingCodeExpiresAt, new Date()),
    )).returning({ id: agents.id });

    if (!updated.length) {
      return Response.json({ error: "Pairing code was already used or expired" }, { status: 409 });
    }

    try {
      await recordAuthSuccess(limiterUsername);
    } catch {
      // Housekeeping only; successful registration must not fail because a
      // security counter could not be cleared.
    }

    return Response.json({ agentId: agent.id, branchId: agent.branchId, secret });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
