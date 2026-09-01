import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printJobs, printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { eq } from "drizzle-orm";
import { createPrintJob } from "@/app/actions";
import { buildTestPrintPayload } from "@/lib/payload";
import { pushJobToAgentWithClaim } from "@/server/ws";

export const dynamic = "force-dynamic";

// Real test print — creates a real printJobs row: queued → claimed → printing → success/failed
// Tauri → Gateway → Agent → Printer (never Tauri → Printer directly)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });
  if (printer.enabled === false) return NextResponse.json({ error: "printer disabled" }, { status: 409 });

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });

  const payload = buildTestPrintPayload(printer.name, (agent as unknown as { name?: string })?.name ?? printer.agentId);

  try {
    const { id: jobId } = await createPrintJob(printer.id, payload);
    // Try immediate WS push if agent connected (best-effort, polling fallback
    // covers offline). A successful push also claims the job so the agent's
    // PATCHes pass the claimed→… transition policy.
    try {
      const jobRow = await db.query.printJobs.findFirst({ where: eq(printJobs.id, jobId) });
      if (jobRow) {
        await pushJobToAgentWithClaim({ id: jobRow.id, agentId: jobRow.agentId, printerId: jobRow.printerId, payload: jobRow.payload, expiresAt: jobRow.expiresAt as unknown as string });
      }
    } catch { }
    return NextResponse.json({ ok: true, jobId, printerId: printer.id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "createPrintJob failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
