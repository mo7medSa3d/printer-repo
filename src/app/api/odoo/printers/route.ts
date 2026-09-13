import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { getEffectivePrinterStatus } from "../../../../lib/agent-availability";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agent_id")?.trim();

  const conditions = [eq(printers.lifecycle, "active"), eq(agents.lifecycle, "active")];
  if (agentId) {
    conditions.push(eq(agents.id, agentId));
  }

  const rows = await db
    .select({
      id: printers.id,
      name: printers.name,
      status: printers.status,
      lifecycle: printers.lifecycle,
      printerType: printers.printerType,
      deviceClass: printers.deviceClass,
      connectionType: printers.connectionType,
      protocol: printers.protocol,
      agentId: agents.id,
      agentName: agents.name,
      agentStatus: agents.status,
      agentLifecycle: agents.lifecycle,
      agentLastSeenAt: agents.lastSeenAt,
    })
    .from(printers)
    .innerJoin(agents, eq(printers.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(printers.name);

  const now = new Date();
  return NextResponse.json({
    printers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: getEffectivePrinterStatus(
        { lifecycle: row.lifecycle, status: row.status },
        { lifecycle: row.agentLifecycle, status: row.agentStatus, lastSeenAt: row.agentLastSeenAt },
        now,
      ),
      lifecycle: row.lifecycle,
      printerType: row.printerType,
      deviceClass: row.deviceClass,
      connectionType: row.connectionType,
      protocol: row.protocol,
      agent: { id: row.agentId, name: row.agentName },
    })),
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
