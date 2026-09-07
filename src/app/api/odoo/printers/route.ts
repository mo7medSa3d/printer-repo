import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../../db";
import { agents, printers } from "../../../../db/schema";
import { validateOdooKey } from "../../../../lib/odoo-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const apiKey = await validateOdooKey(req);
  if (!apiKey) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    })
    .from(printers)
    .innerJoin(agents, eq(printers.agentId, agents.id))
    .where(and(ne(printers.lifecycle, "retired"), ne(agents.lifecycle, "retired")))
    .orderBy(printers.name);

  return NextResponse.json({
    printers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      lifecycle: row.lifecycle,
      printerType: row.printerType,
      deviceClass: row.deviceClass,
      connectionType: row.connectionType,
      protocol: row.protocol,
      agent: { id: row.agentId, name: row.agentName },
    })),
  }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
