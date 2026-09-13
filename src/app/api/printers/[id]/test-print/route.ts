import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { agents, printers } from "../../../../../db/schema";
import { validateManager } from "../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../lib/authorization";
import { requestIdFrom } from "../../../../../lib/log";
import { and, eq } from "drizzle-orm";
import { createPrintJobForPrinter, AgentQueueFullError, AgentQueuedJobsFullError, PrintJobCapabilityError, PrintJobInputError } from "../../../../../lib/print-job-service";
import { buildTestPrintPayloadForPrinter } from "../../../../../lib/payload";
import { MAX_AGENT_IN_FLIGHT_JOBS } from "../../../../../lib/job-delivery";
import { logError } from "../../../../../lib/log";

export const dynamic = "force-dynamic";

// Real test print — creates a real printJobs row: queued → claimed → printing → success/failed
// Tauri → Gateway → Agent → Printer (never Tauri → Printer directly).
//
// Manager-authenticated only: a queued test print reaches physical hardware,
// so it is an operator-console action. The Odoo addon routes its own test
// pages through the durable outbox (/api/print/jobs with a document-scoped
// key), never this endpoint; an installation API key must not be able to
// bypass per-key document-type scoping here.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.test"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const printer = await db.query.printers.findFirst({ where: and(eq(printers.id, id), eq(printers.tenantId, claims.tenantId)) });
  if (!printer) return NextResponse.json({ error: "Printer not found" }, { status: 404 });

  const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, printer.agentId), eq(agents.tenantId, claims.tenantId)) });
  if (!agent) return NextResponse.json({ error: "Printer owner agent missing", code: "AGENT_NOT_FOUND" }, { status: 500 });
  if (printer.lifecycle !== "active") return NextResponse.json({ error: "printer disabled" }, { status: 409 });

  let payload: ReturnType<typeof buildTestPrintPayloadForPrinter>;
  try {
    payload = buildTestPrintPayloadForPrinter(printer.name, agent.name ?? printer.agentId, {
      protocol: printer.protocol,
      connectionType: printer.connectionType,
      capabilities: printer.capabilities,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Test page not supported for this printer", code: "CAPABILITY_MISMATCH", retryable: false }, { status: 422 });
  }

  try {
    const result = await createPrintJobForPrinter(printer.id, payload, {
      requestedBy: "manager-test",
      tenantId: claims.tenantId,
      requestId: requestIdFrom(req),
    });
    return NextResponse.json({ ok: true, jobId: result.id, printerId: printer.id, status: result.status }, { status: 201 });
  } catch (e) {
    if (e instanceof AgentQueueFullError || e instanceof AgentQueuedJobsFullError) {
      return NextResponse.json({
        error: "AGENT_QUEUE_FULL",
        code: "AGENT_QUEUE_FULL",
        agentId: e.agentId,
        limit: MAX_AGENT_IN_FLIGHT_JOBS,
        retryable: true,
      }, { status: 503 });
    }
    if (e instanceof PrintJobCapabilityError) {
      return NextResponse.json({ error: e.message, code: e.code, retryable: false }, { status: 422 });
    }
    if (e instanceof PrintJobInputError) {
      return NextResponse.json({ error: e.message, code: e.code, retryable: e.status >= 500 }, { status: e.status });
    }
    logError("printer.test_print_failed", { printerId: id, error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
  }
}
