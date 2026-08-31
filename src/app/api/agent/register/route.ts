import { db } from "@/db";
import { agents, branches } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { generateSecret, hashSecret } from "@/lib/agent-auth";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const pairingCode = body?.pairingCode;
    const metadata = body?.metadata;
    const branchId = typeof body?.branchId === "string" ? body.branchId.trim() : null;

    if (branchId) {
      try {
        const branch = await db.query.branches.findFirst({ where: eq(branches.id, branchId) });
        if (!branch) {
          return NextResponse.json({ error: "Branch not found" }, { status: 404 });
        }
        if (branch.enabled === false) {
          return NextResponse.json({ error: "Branch is disabled" }, { status: 409 });
        }
      } catch {
        // Migration has not been applied yet; retain legacy behavior until the
        // schema is backfilled in a deployed environment.
      }
    }

    if (!pairingCode || typeof pairingCode !== "string") {
      return NextResponse.json({ error: "Pairing code required" }, { status: 400 });
    }

    // Single-use + short-lived: the WHERE clause below only matches a
    // still-unconsumed, unexpired code. The subsequent UPDATE clears
    // pairingCode so a second registration attempt with the same code
    // (e.g. a retry racing a legitimate first use) will find no match.
    const normalizedCode = pairingCode.trim().toUpperCase();

    const agent = await db.query.agents.findFirst({
      where: and(
        eq(agents.pairingCode, normalizedCode),
        gt(agents.pairingCodeExpiresAt, new Date())
      ),
    });

    if (!agent) {
      return NextResponse.json({ error: "Invalid or expired pairing code" }, { status: 400 });
    }

    const secret = generateSecret();

    const updated = await db.update(agents)
      .set({
        pairingCode: null,
        pairingCodeExpiresAt: null,
        branchId: branchId ?? agent.branchId,
        secret: hashSecret(secret),
        status: "online",
        metadata: (metadata && typeof metadata === "object") ? metadata : {},
        lastSeenAt: new Date(),
      })
      .where(and(
        eq(agents.id, agent.id),
        eq(agents.pairingCode, normalizedCode) // re-check: reject if raced/consumed between read and write
      ))
      .returning({ id: agents.id });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Pairing code was already used" }, { status: 409 });
    }

    // The plaintext secret is returned exactly once, here, and never again.
    return NextResponse.json({
      agentId: agent.id,
      secret,
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
