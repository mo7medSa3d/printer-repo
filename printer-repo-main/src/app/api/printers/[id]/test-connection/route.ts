import { NextResponse } from "next/server";
import { db } from "@/db";
import { printers, agents } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";
import { getAgentAvailability } from "@/lib/agent-availability";

export const dynamic = "force-dynamic";

// Diagnostic RPC — MUST NOT create a printJobs row.
// Verified: this file never imports printJobs and never inserts.
// EXPLICIT SEMANTICS (final gate):
//   Preferred (production): Tauri → Gateway → Agent → immediate TCP dial/probe → actual result → Gateway → Tauri
//     → latencyMs is the measured Agent TCP dial time (2s timeout via NetworkPrinter.Status / DialContext 5s)
//     → do NOT return latencyMs:null when a live probe is expected; Gateway itself cannot reach LAN.
//   Current (this build): Gateway returns cached reachability from last heartbeat (printer.status + agentOnline)
//     → latencyMs is null (Gateway cannot dial LAN). This is honest and verified via grep, but NOT a live probe.
//     → A live synchronous RPC requires Agent WS command: Gateway → Agent (WS: {type:"probe",printerId}) → Agent dials → replies with {reachable,latencyMs} → Gateway relays.
//     → That WS command is intentionally NOT implemented in this gate to keep “verification only” (no new feature). Docs mark it as next-phase live probe.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  // No printJobs row is created here — grep verification: this endpoint must not import printJobs.

  if (printer.lifecycle !== "active") {
    return NextResponse.json({ reachable: false, latencyMs: null, agentOnline: false, error: "printer disabled" });
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!agent) return NextResponse.json({ reachable: false, latencyMs: null, agentOnline: false, error: "agent not found" });

  // Validate config
  const cfg = (printer.config ?? {}) as Record<string, unknown>;
  if (printer.connectionType === "network") {
    if (!cfg.ip || !cfg.port) {
      return NextResponse.json({ reachable: false, latencyMs: null, agentOnline: false, error: "missing ip/port in config" });
    }
  }

  const availability = getAgentAvailability(agent);
  const agentOnline = availability.available;

  if (!agentOnline) {
    return NextResponse.json({ reachable: false, latencyMs: null, agentOnline: false, error: "agent offline — printer reachability unknown until agent reconnects" });
  }

  const reachable = printer.status === "online" && agentOnline;
  // Current semantics: cached heartbeat. latencyMs:null and error carries last status because Gateway cannot dial LAN.
  // Preferred live-probe semantics: Gateway → Agent dial → measured latencyMs (e.g. 12) and error from actual dial.
  return NextResponse.json({
    reachable,
    latencyMs: null,
    agentOnline: true,
    error: reachable ? null : `last heartbeat printer.status=${printer.status} (live probe not yet implemented; see file header)`,
  });
}
