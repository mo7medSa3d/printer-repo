import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, gt } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { metadataField } from "@/lib/limits";
import { generateSecret, hashSecret } from "@/lib/agent-auth";
import { logWarn } from "@/lib/log";

/**
 * Agent pairing.
 *
 * The branch is NOT part of this contract. A physical device must never be
 * able to choose which branch it belongs to: the branch is a property of the
 * Agent record, which a manager created deliberately (see `createAgent`). The
 * pairing code is the only credential, and it resolves to exactly one Agent,
 * whose `branch_id` is authoritative.
 *
 * The schema is `.strict()`, so a client that still sends `branchId` gets a
 * 400 naming the field instead of silently having it ignored — a compromised
 * or misconfigured device learns immediately that it cannot self-assign.
 */
const registerSchema = z.object({
  pairingCode: z.string().min(1).max(64),
  metadata: metadataField(),
}).strict();

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      const suppliedBranch =
        body && typeof body === "object" && "branchId" in (body as Record<string, unknown>);
      if (suppliedBranch) {
        // Explicitly refused, not ignored: an agent does not get to pick a branch.
        logWarn("agent.register.rejected", { reason: "client_supplied_branch" });
        return NextResponse.json({
          error:
            "branchId is not accepted during agent registration: an agent's branch is set when a manager creates the agent, and printers derive their branch from the agent (branch → agent → printer). Remove the field and pair with the code alone.",
        }, { status: 400 });
      }
      return NextResponse.json({ error: "Invalid registration payload" }, { status: 400 });
    }

    const { pairingCode, metadata } = parsed.data;

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
        // NOTE: branchId is deliberately absent. The agent keeps the branch it
        // was created with; pairing never moves an agent between branches.
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
