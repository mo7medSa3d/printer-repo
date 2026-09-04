import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers, agents } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";
import { getAgentAvailability } from "@/lib/agent-availability";

export const dynamic = "force-dynamic";

// Diagnostic endpoint. This build intentionally reports cached heartbeat state,
// not a live LAN probe. `live: false` is part of the response contract so UIs
// cannot present cached reachability as a just-tested TCP result.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  const lastHeartbeatAt = printer.lastSeenAt;

  if (printer.lifecycle !== "active") {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      lastHeartbeatAt,
      agentOnline: false,
      error: "printer disabled",
    });
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!agent) return NextResponse.json({
    reachable: false,
    latencyMs: null,
    live: false,
    lastHeartbeatAt,
    agentOnline: false,
    error: "agent not found",
  }, { status: 404 });

  const cfg = (printer.config ?? {}) as Record<string, unknown>;
  if (printer.connectionType === "network" && (!cfg.ip || !cfg.port)) {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      lastHeartbeatAt,
      agentOnline: false,
      error: "missing ip/port in config",
    });
  }

  const availability = getAgentAvailability(agent);
  const agentOnline = availability.available;
  if (!agentOnline) {
    return NextResponse.json({
      reachable: false,
      latencyMs: null,
      live: false,
      lastHeartbeatAt,
      agentOnline: false,
      error: "agent offline — printer reachability unknown until agent reconnects",
    });
  }

  const reachable = printer.status === "online" && agentOnline;
  return NextResponse.json({
    reachable,
    latencyMs: null,
    live: false,
    lastHeartbeatAt,
    agentOnline: true,
    error: reachable ? null : `last heartbeat printer.status=${printer.status}`,
  });
}
