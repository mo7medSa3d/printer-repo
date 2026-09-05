import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { agents, discoveredDevices } from "../../../../../../../db/schema";
import { validateManager } from "../../../../../../../lib/manager-auth";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Manager approval is deliberately explicit. It is not a claim that a printer
 * was technically probed by the gateway; it is the authorization boundary that
 * permits a discovered observation to become provisionable.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; deviceId: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: agentId, deviceId } = await params;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });

  const device = await db.query.discoveredDevices.findFirst({
    where: and(
      eq(discoveredDevices.id, deviceId),
      eq(discoveredDevices.agentId, agentId),
      eq(discoveredDevices.branchId, agent.branchId),
    ),
  });
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (device.candidateStatus === "provisioned") {
    return NextResponse.json({ error: "Device is already provisioned" }, { status: 409 });
  }
  if (device.verification === "verified" && device.candidateStatus === "verified") {
    return NextResponse.json({ ok: true, already: true, deviceId });
  }

  const updated = await db.update(discoveredDevices)
    .set({
      // Approval is authorization, not technical evidence. Preserve the
      // discovery confidence score generated from actual device observations.
      verification: "verified",
      candidateStatus: "verified",
      updatedAt: new Date(),
    })
    .where(and(
      eq(discoveredDevices.id, deviceId),
      eq(discoveredDevices.agentId, agentId),
      eq(discoveredDevices.branchId, agent.branchId),
      eq(discoveredDevices.candidateStatus, "discovered"),
    ))
    .returning({ id: discoveredDevices.id });

  if (updated.length !== 1) {
    return NextResponse.json({ error: "Device state changed concurrently; reload and retry" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, verified: true, deviceId });
}
