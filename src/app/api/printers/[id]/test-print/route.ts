import { NextResponse } from "next/server";
import { validateManager } from "@/lib/manager-auth";
import { validateOdooKey } from "@/lib/odoo-auth";
import { loadPrinterWithBranch } from "@/lib/printer-branch";
import { createPrintJob } from "@/app/actions";
import { buildTestPrintPayload } from "@/lib/payload";

export const dynamic = "force-dynamic";

// Real test print — creates a real printJobs row: queued → claimed → printing → success/failed
// Tauri → Gateway → Agent → Printer (never Tauri → Printer directly)
//
// Two callers authenticate here:
//   - Desktop Manager (Tauri) sends a manager session (cookie/Bearer);
//   - the Odoo addon (print_gateway.printer.action_test_print) sends a
//     branch-scoped Odoo API key — it has no manager session. Without the
//     Odoo-key path the addon's Test Print button always got 401.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Authorization is branch-scoped, and the branch is DERIVED through the
  // printer's agent — never read off the printer row and never taken from the
  // client. Knowing a printer_id alone must not grant cross-branch access.
  const loaded = await loadPrinterWithBranch(id);
  if (!loaded.ok) {
    if (loaded.error === "PRINTER_NOT_FOUND") return NextResponse.json({ error: "Printer not found" }, { status: 404 });
    // A broken printer → agent → branch chain must fail closed, not fall back
    // to an unscoped check.
    return NextResponse.json({ error: loaded.message }, { status: 409 });
  }
  const printer = loaded.printer;

  const claims = await validateManager(req);
  const odoo = claims ? null : await validateOdooKey(req, printer.branchId);
  if (!claims && !odoo) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (printer.enabled === false) return NextResponse.json({ error: "printer disabled" }, { status: 409 });

  const agent = printer.agent;

  const payload = buildTestPrintPayload(printer.name, (agent as unknown as { name?: string })?.name ?? printer.agentId);

  try {
    // createPrintJob inserts the durable row AND does the best-effort WS push
    // with claim (see src/app/actions.ts) — pushing again here would deliver
    // the job twice over the agent socket.
    const { id: jobId } = await createPrintJob(printer.id, payload);
    return NextResponse.json({ ok: true, jobId, printerId: printer.id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "createPrintJob failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
