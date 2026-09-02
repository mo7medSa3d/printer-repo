import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateSecret, hashSecret } from "@/lib/agent-auth";
import { z } from "zod";

const registrationSchema = z.object({
  agentId: z.string().trim().min(1).max(120),
  pairingCode: z.string().trim().min(1).max(64),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body?.metadata && JSON.stringify(body.metadata).length > 32_768) {
      return NextResponse.json({ error: "metadata exceeds 32KB" }, { status: 400 });
    }
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "agentId and pairingCode are required; branchId is not accepted" }, { status: 400 });
    if (body && typeof body === "object" && "branchId" in body) {
      return NextResponse.json({ error: "branchId is not accepted during registration" }, { status: 400 });
    }
    const normalizedCode = parsed.data.pairingCode.toUpperCase();
    const conditions = [
      eq(agents.pairingCode, normalizedCode),
      gt(agents.pairingCodeExpiresAt, new Date()),
      eq(agents.lifecycle, "active"),
    ];
    conditions.push(eq(agents.id, parsed.data.agentId));
    const agent = await db.query.agents.findFirst({ where: and(...conditions) });
    if (!agent) return NextResponse.json({ error: "Unknown, disabled, retired, or expired agent registration" }, { status: 400 });
    const secret = generateSecret();
    const updated = await db.update(agents).set({
      pairingCode: null,
      pairingCodeExpiresAt: null,
      secret: hashSecret(secret),
      status: "online",
      metadata: parsed.data.metadata ?? {},
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(agents.id, agent.id), eq(agents.pairingCode, normalizedCode), eq(agents.lifecycle, "active"))).returning({ id: agents.id });
    if (!updated.length) return NextResponse.json({ error: "Pairing code was already used" }, { status: 409 });
    return NextResponse.json({ agentId: agent.id, branchId: agent.branchId, secret });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
