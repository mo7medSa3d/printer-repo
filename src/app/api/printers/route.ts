import { NextResponse } from "next/server";
import { db } from "../../../db";
import { agents, printers } from "../../../db/schema";
import { validateManager } from "../../../lib/manager-auth";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { parsePrinterInput, validateConnectionConfig } from "../../../lib/printer-model";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select().from(printers).where(eq(printers.tenantId, claims.tenantId)).orderBy(desc(printers.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    const data = parsePrinterInput(body);
    const agent = await db.query.agents.findFirst({ where: and(eq(agents.id, data.agentId), eq(agents.tenantId, claims.tenantId)) });
    if (!agent) return NextResponse.json({ error: "agentId not found" }, { status: 404 });
    if (agent.lifecycle !== "active") return NextResponse.json({ error: `agent is ${agent.lifecycle}` }, { status: 409 });
    const error = validateConnectionConfig(data.connectionType, data.config);
    if (error) return NextResponse.json({ error }, { status: 400 });
    const id = data.id ?? `printer_${nanoid(8)}`;
    const [row] = await db.insert(printers).values({
      id,
      tenantId: claims.tenantId,
      agentId: data.agentId,
      name: data.name,
      printerType: data.printerType,
      deviceClass: data.deviceClass,
      connectionType: data.connectionType,
      protocol: data.protocol,
      status: "unknown",
      lifecycle: "active",
      config: data.config,
      capabilities: data.capabilities ?? null,
    }).returning();
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /already exists|duplicate/i.test(error.message)) return NextResponse.json({ error: "printer id already exists" }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid printer payload" }, { status: 400 });
  }
}
