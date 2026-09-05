import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, printers } from "@/db/schema";
import { validateManager } from "@/lib/manager-auth";
import { validateOdooKey } from "@/lib/odoo-auth";
import { eq } from "drizzle-orm";
import { createPrintJobForPrinter, AgentQueueFullError } from "@/lib/print-job-service";
import { buildTestPrintPayload } from "@/lib/payload";

export const dynamic = "force-dynamic";

// Real test print — creates a real printJobs row: queued → claimed → printing → success/failed
// Tauri → Gateway → Agent → Printer (never Tauri → Printer directly)
//
// Two callers authenticate here:
//   - Desktop Manager (Tauri) sends a manager session (cookie/Bearer);
//   - the Odoo addon (print_gateway.printer.action_test_print) sends a
//     branch-scoped Odoo API key — it has no manager session.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const printer = await db.query.printers.findFirst({ where: eq(printers.id, id) });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, printer.agentId) });
  if (!agent) return NextResponse.json({ error: "Printer owner agent missing" }, { status: 500 });

  const claims = await validateManager(req);
  const odoo = claims ? null : await validateOdooKey(req, agent.branchId);
  if (!claims && !odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (printer.lifecycle !== "active") return NextResponse.json({ error: "printer disabled" }, { status: 409 });
  if (odoo?.branchId && odoo.branchId !== agent.branchId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const payload = buildTestPrintPayload(printer.name, agent.name ?? printer.agentId);

  try {
    const result = await createPrintJobForPrinter(printer.id, payload, {
      requestedBy: claims ? "manager-test" : "odoo-test",
    });
    return NextResponse.json({ ok: true, jobId: result.id, printerId: printer.id, status: result.status }, { status: 201 });
  } catch (e) {
    if (e instanceof AgentQueueFullError) {
      return NextResponse.json({
        error: "AGENT_QUEUE_FULL",
        code: "AGENT_QUEUE_FULL",
        agentId: e.agentId,
        inFlight: e.inFlight,
        limit: 500,
        retryable: true,
      }, { status: 503 });
    }
    const msg = e instanceof Error ? e.message : "createPrintJob failed";
    const status = /not online/i.test(msg) ? 503
      : /virtual or redirected/i.test(msg) ? 409
      : /capability|cannot print/i.test(msg) ? 422
      : /disabled|retired/i.test(msg) ? 409
      : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
